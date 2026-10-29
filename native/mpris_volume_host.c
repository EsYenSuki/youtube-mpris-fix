/*
 * Native messaging host: receives YouTube's slider value (integer percent) from the
 * extension and writes it to the browser's MPRIS Volume as 0.xx via playerctl.
 *
 * Protocol: 4-byte native-endian length prefix + UTF-8 JSON, in both directions.
 * Request:  {"volume": <integer 0..100>}
 * Reply:    {"ok": true, "player": "...", "volume": "0.xx", "skipped": bool}
 *           {"ok": false, "error": "..."}
 *
 * Build: cc -O2 -Wall -Wextra -o mpris_volume_host mpris_volume_host.c
 */
#define _POSIX_C_SOURCE 200809L

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAX_MSG (64 * 1024)
#define PLAYER_MAX 256

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
    return fflush(stdout) == 0 ? 0 : -1;
}

/* Runs argv with no shell. Captures stdout into out (NUL-terminated).
 * Returns the exit status, or -1 if the command could not run. */
static int run_capture(char *const argv[], char *out, size_t outsz) {
    int pipefd[2];
    if (pipe(pipefd) != 0) return -1;
    pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }
    if (pid == 0) {
        dup2(pipefd[1], STDOUT_FILENO);
        close(pipefd[0]);
        close(pipefd[1]);
        int devnull = open("/dev/null", 2);
        if (devnull >= 0) dup2(devnull, STDERR_FILENO);
        execvp(argv[0], argv);
        _exit(127);
    }
    close(pipefd[1]);
    size_t used = 0;
    for (;;) {
        ssize_t r = read(pipefd[0], out + used, outsz - 1 - used);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) break;
        used += (size_t)r;
        if (used >= outsz - 1) break;
    }
    out[used] = '\0';
    close(pipefd[0]);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

/* Finds the first MPRIS player whose name starts with "firefox." (Zen uses firefox.instance_N). */
static int find_player(char *player, size_t sz) {
    char list[4096];
    char *const argv[] = {"playerctl", "-l", NULL};
    if (run_capture(argv, list, sizeof list) != 0) return -1;
    char *save = NULL;
    for (char *tok = strtok_r(list, "\n", &save); tok; tok = strtok_r(NULL, "\n", &save)) {
        if (strncmp(tok, "firefox.", 8) == 0) {
            snprintf(player, sz, "%s", tok);
            return 0;
        }
    }
    return -1;
}

/* Parses the JSON for an integer "volume" field, rejecting non-integers and out-of-range values. */
static int parse_volume(const char *json, long *out) {
    const char *key = strstr(json, "\"volume\"");
    if (!key) return -1;
    const char *p = key + strlen("\"volume\"");
    while (*p == ' ' || *p == '\t' || *p == ':') p++;
    if (*p == '\0' || (!isdigit((unsigned char)*p) && *p != '-')) return -1;
    char *end;
    errno = 0;
    long v = strtol(p, &end, 10);
    if (errno != 0 || end == p) return -1;
    if (*end != ',' && *end != '}' && *end != ' ' && *end != '\0') return -1;
    if (v < 0 || v > 100) return -1;
    *out = v;
    return 0;
}

static void reply_error(const char *msg) {
    char buf[512];
    snprintf(buf, sizeof buf, "{\"ok\":false,\"error\":\"%s\"}", msg);
    send_json(buf);
}

static void handle_volume(long percent) {
    char player[PLAYER_MAX];
    if (find_player(player, sizeof player) != 0) {
        reply_error("no firefox MPRIS player");
        return;
    }

    char target[8];
    snprintf(target, sizeof target, "%.2f", (double)percent / 100.0);

    /* Skip the write when MPRIS already holds this value. */
    char cur[64];
    char *const get[] = {"playerctl", "-p", player, "volume", NULL};
    if (run_capture(get, cur, sizeof cur) == 0) {
        double c = strtod(cur, NULL);
        if (fabs(c - (double)percent / 100.0) < 0.005) {
            char buf[512];
            snprintf(buf, sizeof buf,
                     "{\"ok\":true,\"player\":\"%s\",\"volume\":\"%s\",\"skipped\":true}",
                     player, target);
            send_json(buf);
            return;
        }
    }

    char discard[64];
    char *const set[] = {"playerctl", "-p", player, "volume", target, NULL};
    if (run_capture(set, discard, sizeof discard) != 0) {
        reply_error("playerctl volume write failed");
        return;
    }
    char buf[512];
    snprintf(buf, sizeof buf,
             "{\"ok\":true,\"player\":\"%s\",\"volume\":\"%s\",\"skipped\":false}",
             player, target);
    send_json(buf);
}

int main(void) {
    static char msg[MAX_MSG + 1];
    for (;;) {
        uint32_t len;
        if (read_full(&len, sizeof len) != 0) break;
        if (len == 0 || len > MAX_MSG) break; /* browsers cap messages; treat as protocol error */
        if (read_full(msg, len) != 0) break;
        msg[len] = '\0';

        long percent;
        if (parse_volume(msg, &percent) != 0) {
            reply_error("volume must be an integer 0..100");
            continue;
        }
        handle_volume(percent);
    }
    return 0;
}
