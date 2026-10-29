/*
 * Native messaging host: owns the browser's MPRIS Volume on behalf of the extension.
 *
 * Why this exists
 * ---------------
 * Firefox stores MPRIS Volume in its own variable and applies it to every media
 * element when it is set. It never copies the page's volume back into that
 * variable, and it emits no PropertiesChanged signal for Volume. Therefore the
 * only way to notice an external volume change is to poll the property, and the
 * only way to avoid a feedback loop is for one side to remember exactly which
 * changes it caused.
 *
 * This host is that side. It polls MPRIS, pushes only changes it did not make,
 * and refuses to write a value MPRIS already holds. The extension never has to
 * guess whether an incoming value is its own echo.
 *
 * Protocol: 4-byte native-endian length prefix + UTF-8 JSON, in both directions.
 *
 * Extension -> host
 *   {"type":"set","volume":<0..1>}      set MPRIS volume, full double precision
 *   {"type":"get"}                      read the current MPRIS volume
 *   {"millis":<0..1000>}                legacy form, same as "set"
 *   {"volume":<0..100>}                 legacy form, percent
 *
 * Host -> extension (unsolicited, whenever MPRIS changes externally)
 *   {"type":"volume","volume":<0..1>,"millis":<0..1000>}
 *
 * Replies
 *   {"ok":true,"volume":<0..1>,"millis":N,"skipped":bool}
 *   {"ok":false,"error":"..."}
 *
 * The millis field is retained only for older extension versions. The current
 * extension uses volume, so no decimal places are cut on the wire.
 *
 * Build: cc -O2 -Wall -Wextra -std=c11 -D_DEFAULT_SOURCE \
 *            $(pkg-config --cflags --libs gio-2.0) -o mpris_volume_host \
 *            mpris_volume_host.c -lm
 */
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <math.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <gio/gio.h>

#define MAX_MSG (64 * 1024)
#define POLL_MS 200
#define CALL_TIMEOUT_MS 500
/* Small enough to preserve real changes, large enough for double round-trips. */
#define VOLUME_EPS 1e-9

#define OBJECT_PATH "/org/mpris/MediaPlayer2"
#define PLAYER_IFACE "org.mpris.MediaPlayer2.Player"
#define PROPS_IFACE "org.freedesktop.DBus.Properties"
#define MPRIS_PREFIX "org.mpris.MediaPlayer2."

/* Read exactly n bytes; returns 0 on success, -1 on EOF/error. */
static int read_full(void *buf, size_t n) {
    unsigned char *p = buf;
    while (n > 0) {
        ssize_t r = read(STDIN_FILENO, p, n);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) return -1;
        p += r;
        n -= (size_t)r;
    }
    return 0;
}

static int write_full(const void *buf, size_t n) {
    const unsigned char *p = buf;
    while (n > 0) {
        ssize_t w = write(STDOUT_FILENO, p, n);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return -1;
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

static int send_json(const char *json) {
    uint32_t len = (uint32_t)strlen(json);
    if (write_full(&len, sizeof len) != 0) return -1;
    if (write_full(json, len) != 0) return -1;
    return 0;
}

static void reply_error(const char *msg) {
    char buf[512];
    snprintf(buf, sizeof buf, "{\"ok\":false,\"error\":\"%s\"}", msg);
    send_json(buf);
}

/* Legacy millis field for older extension versions. The volume itself is never
 * quantized. The epsilon handles binary float error (0.29 * 1000 == 289.999...). */
static long volume_to_millis(double volume) {
    if (!(volume > 0.0)) return 0; /* also catches NaN */
    if (volume > 1.0) volume = 1.0;
    long millis = (long)floor(volume * 1000.0 + 1e-6);
    if (millis < 0) millis = 0;
    if (millis > 1000) millis = 1000;
    return millis;
}

static GDBusConnection *bus;
static char *player;
static double last_volume;
static int have_last;

static int ensure_bus(void) {
    if (bus) return 0;
    GError *error = NULL;
    bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (!bus) {
        g_clear_error(&error);
        return -1;
    }
    return 0;
}

static int is_browser_player(const char *name) {
    size_t prefix = strlen(MPRIS_PREFIX);
    if (strncmp(name, MPRIS_PREFIX, prefix) != 0) return 0;
    const char *instance = name + prefix;
    /* Zen and forks report themselves as firefox.instance_N. */
    return strncmp(instance, "firefox.", 8) == 0 ||
           strncmp(instance, "zen.", 4) == 0 ||
           strncmp(instance, "librewolf.", 10) == 0;
}

/* Finds the first browser MPRIS player. Names look like
 * org.mpris.MediaPlayer2.firefox.instance_1_253. */
static char *find_player(void) {
    GError *error = NULL;
    GVariant *names = g_dbus_connection_call_sync(
        bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus", "ListNames", NULL, G_VARIANT_TYPE("(as)"),
        G_DBUS_CALL_FLAGS_NONE, CALL_TIMEOUT_MS, NULL, &error);
    if (!names) {
        g_clear_error(&error);
        return NULL;
    }

    char *found = NULL;
    GVariantIter *iter;
    const char *name;
    g_variant_get(names, "(as)", &iter);
    while (g_variant_iter_next(iter, "&s", &name)) {
        if (is_browser_player(name)) {
            found = g_strdup(name);
            break;
        }
    }
    g_variant_iter_free(iter);
    g_variant_unref(names);
    return found;
}

static int get_volume(const char *dest, double *out) {
    GError *error = NULL;
    GVariant *reply = g_dbus_connection_call_sync(
        bus, dest, OBJECT_PATH, PROPS_IFACE, "Get",
        g_variant_new("(ss)", PLAYER_IFACE, "Volume"), G_VARIANT_TYPE("(v)"),
        G_DBUS_CALL_FLAGS_NONE, CALL_TIMEOUT_MS, NULL, &error);
    if (!reply) {
        g_clear_error(&error);
        return -1;
    }

    GVariant *value = NULL;
    g_variant_get(reply, "(v)", &value);
    int ok = 0;
    if (value && g_variant_is_of_type(value, G_VARIANT_TYPE_DOUBLE)) {
        double volume = g_variant_get_double(value);
        if (isfinite(volume)) {
            *out = volume;
            ok = 1;
        }
    }
    if (value) g_variant_unref(value);
    g_variant_unref(reply);
    return ok ? 0 : -1;
}

static int set_volume(const char *dest, double volume) {
    GError *error = NULL;
    GVariant *reply = g_dbus_connection_call_sync(
        bus, dest, OBJECT_PATH, PROPS_IFACE, "Set",
        g_variant_new("(ssv)", PLAYER_IFACE, "Volume",
                      g_variant_new_double(volume)),
        NULL, G_DBUS_CALL_FLAGS_NONE, CALL_TIMEOUT_MS, NULL, &error);
    if (!reply) {
        g_clear_error(&error);
        return -1;
    }
    g_variant_unref(reply);
    return 0;
}

/* Reads the live MPRIS volume, re-resolving the player when it goes away. */
static int read_current(double *out) {
    if (ensure_bus() != 0) return -1;
    for (int attempt = 0; attempt < 2; attempt++) {
        if (player) {
            double volume;
            if (get_volume(player, &volume) == 0) {
                *out = volume;
                return 0;
            }
            g_free(player);
            player = NULL;
        }
        player = find_player();
        if (!player) return -1;
    }
    return -1;
}

/* Polls MPRIS and pushes any change we did not make. Our own writes update
 * last_volume first, so they are never reported back to the extension. */
static void watch_volume(void) {
    double volume;
    if (read_current(&volume) != 0) {
        have_last = 0; /* player gone; re-baseline when it returns */
        return;
    }
    if (!have_last) {
        last_volume = volume;
        have_last = 1;
        return;
    }
    if (fabs(volume - last_volume) <= VOLUME_EPS) return;
    last_volume = volume;
    char buf[160];
    snprintf(buf, sizeof buf,
             "{\"type\":\"volume\",\"volume\":%.17g,\"millis\":%ld}",
             volume, volume_to_millis(volume));
    send_json(buf);
}

static void handle_set(double volume) {
    if (!isfinite(volume)) {
        reply_error("volume must be a finite number 0..1");
        return;
    }
    if (volume < 0.0) volume = 0.0;
    if (volume > 1.0) volume = 1.0;

    double current;
    if (read_current(&current) != 0) {
        reply_error("no browser MPRIS player");
        return;
    }

    int skipped = fabs(current - volume) <= VOLUME_EPS;
    if (!skipped && set_volume(player, volume) != 0) {
        reply_error("MPRIS volume write failed");
        return;
    }

    /* Remember what MPRIS actually stored. If Firefox rounds the value, the
     * poll below must compare against the rounded value, not the request. */
    double actual = skipped ? current : volume;
    if (!skipped) {
        double seen;
        if (read_current(&seen) == 0) actual = seen;
    }
    last_volume = actual;
    have_last = 1;

    char buf[256];
    snprintf(buf, sizeof buf,
             "{\"ok\":true,\"volume\":%.17g,\"millis\":%ld,\"skipped\":%s}",
             actual, volume_to_millis(actual), skipped ? "true" : "false");
    send_json(buf);
}

static void handle_get(void) {
    double volume;
    if (read_current(&volume) != 0) {
        reply_error("no browser MPRIS player");
        return;
    }
    if (!have_last) {
        last_volume = volume;
        have_last = 1;
    }
    char buf[160];
    snprintf(buf, sizeof buf,
             "{\"ok\":true,\"volume\":%.17g,\"millis\":%ld}", volume,
             volume_to_millis(volume));
    send_json(buf);
}

static int parse_long_field(const char *json, const char *key, long *out) {
    const char *found = strstr(json, key);
    if (!found) return -1;
    const char *p = found + strlen(key);
    while (*p == ' ' || *p == '\t' || *p == ':') p++;
    if (*p == '\0' || ((*p < '0' || *p > '9') && *p != '-')) return -1;
    char *end;
    errno = 0;
    long value = strtol(p, &end, 10);
    if (errno != 0 || end == p) return -1;
    if (*end != ',' && *end != '}' && *end != ' ' && *end != '\t' && *end != '\0')
        return -1;
    *out = value;
    return 0;
}

static int parse_double_field(const char *json, const char *key, double *out) {
    const char *found = strstr(json, key);
    if (!found) return -1;
    const char *p = found + strlen(key);
    while (*p == ' ' || *p == '\t' || *p == ':') p++;
    if (*p == '\0' || *p == '"') return -1;
    char *end;
    errno = 0;
    double value = strtod(p, &end);
    if (errno != 0 || end == p || !isfinite(value)) return -1;
    if (*end != ',' && *end != '}' && *end != ' ' && *end != '\t' && *end != '\0')
        return -1;
    *out = value;
    return 0;
}

static int parse_type(const char *json, char *out, size_t out_size) {
    const char *found = strstr(json, "\"type\"");
    if (!found) return -1;
    const char *p = found + strlen("\"type\"");
    while (*p == ' ' || *p == '\t' || *p == ':') p++;
    if (*p != '"') return -1;
    p++;
    size_t used = 0;
    while (*p && *p != '"' && used + 1 < out_size) out[used++] = *p++;
    out[used] = '\0';
    return 0;
}

static void handle_message(const char *json) {
    char type[16];
    if (parse_type(json, type, sizeof type) == 0) {
        if (strcmp(type, "get") == 0) {
            handle_get();
            return;
        }
        if (strcmp(type, "set") == 0) {
            double volume;
            if (parse_double_field(json, "\"volume\"", &volume) == 0) {
                if (volume < 0.0 || volume > 1.0) {
                    reply_error("volume must be a number 0..1");
                    return;
                }
                handle_set(volume);
                return;
            }
            long millis;
            if (parse_long_field(json, "\"millis\"", &millis) == 0 &&
                millis >= 0 && millis <= 1000) {
                handle_set((double)millis / 1000.0);
                return;
            }
            reply_error("expected volume 0..1 or millis 0..1000");
            return;
        }
        reply_error("unknown request type");
        return;
    }

    /* Legacy requests from older extension versions. */
    long millis;
    if (parse_long_field(json, "\"millis\"", &millis) == 0) {
        if (millis < 0 || millis > 1000) {
            reply_error("millis must be an integer 0..1000");
            return;
        }
        handle_set((double)millis / 1000.0);
        return;
    }

    long percent;
    if (parse_long_field(json, "\"volume\"", &percent) == 0) {
        if (percent < 0 || percent > 100) {
            reply_error("volume must be an integer 0..100");
            return;
        }
        handle_set((double)percent / 100.0);
        return;
    }

    reply_error("expected {\"type\":\"set\",\"volume\":V}");
}

int main(void) {
    static char msg[MAX_MSG + 1];
    struct pollfd stdin_poll = {STDIN_FILENO, POLLIN, 0};

    for (;;) {
        int ready = poll(&stdin_poll, 1, POLL_MS);
        if (ready < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (ready > 0 &&
            (stdin_poll.revents & (POLLIN | POLLHUP | POLLERR))) {
            uint32_t len;
            if (read_full(&len, sizeof len) != 0) break;
            if (len == 0 || len > MAX_MSG) break;
            if (read_full(msg, len) != 0) break;
            msg[len] = '\0';
            handle_message(msg);
        }
        /* Also runs right after a message, which keeps last_volume in sync
         * with what we just wrote. */
        watch_volume();
    }

    g_free(player);
    if (bus) g_object_unref(bus);
    return 0;
}
