/* Decoy that impersonates the jcode background server on the process table so
 * that whatever is killing the daemon hits this too - and, unlike the daemon,
 * records who did it.
 *
 * The real server dies to a plain SIGTERM; Rust's signal handler never sees the
 * sender. A SA_SIGINFO handler does: the kernel fills siginfo_t.si_pid for any
 * signal delivered via kill(2), which is what pkill/killall/kill all use. We
 * write that pid, then let the guard-side script resolve its argv.
 *
 * Build:  cc -O2 -o jcode decoy.c
 * Run  :  ./jcode --provider auto serve        (argv must match the daemon's)
 *
 * It never binds a socket, so no client can mistake it for the real daemon.
 */

#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static const char *LOGFILE = NULL;

/* Async-signal-safe: open/write/close only, no stdio, no malloc. */
static void on_signal(int signo, siginfo_t *info, void *ctx) {
    (void)ctx;
    char line[256];
    int n = snprintf(line, sizeof(line), "SIGNAL sig=%d sender_pid=%d sender_uid=%d\n",
                     signo, (int)info->si_pid, (int)info->si_uid);
    int fd = open(LOGFILE, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd >= 0) {
        ssize_t ignored = write(fd, line, (size_t)n);
        (void)ignored;
        close(fd);
    }
    /* Stay alive: a repeating killer must be recorded every time, not once. */
}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;

    static char path[512];
    const char *home = getenv("HOME");
    snprintf(path, sizeof(path), "%s/.jcode/logs/sigterm-decoy.log", home ? home : "/tmp");
    LOGFILE = path;

    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_sigaction = on_signal;
    sa.sa_flags = SA_SIGINFO | SA_RESTART;
    sigemptyset(&sa.sa_mask);

    int signals[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1};
    for (unsigned i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) {
        sigaction(signals[i], &sa, NULL);
    }

    FILE *fh = fopen(LOGFILE, "a");
    if (fh) {
        time_t now = time(NULL);
        struct tm tm;
        localtime_r(&now, &tm);
        char stamp[32];
        strftime(stamp, sizeof(stamp), "%Y-%m-%d %H:%M:%S", &tm);
        fprintf(fh, "[%s] decoy up pid=%d\n", stamp, (int)getpid());
        fclose(fh);
    }

    for (;;) {
        pause();
    }
}
