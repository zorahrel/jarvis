/* Lanciatore del server jcode sul canale shared-server: fa partire ~/.jcode/signed/jcode (la copia firmata accanto a
 * questo file) responsabile di sé stesso per TCC, come lo era con la guardia launchd.
 *
 * Perché: dal 25/10 il server lo avvia il client (TUI, `jcode acp` di Topics) e un figlio eredita il *responsabile* del
 * padre (claude.app, Terminale, Topics): i permessi dati alla copia firmata dev.jcode.signed smettevano di valere e i
 * dialoghi uscivano a nome dell'app del client. posix_spawn con responsibility_spawnattrs_setdisclaim è il modo in cui
 * terminali e launcher macOS (Chromium, il disclaim di Qt Creator) fanno nascere un figlio responsabile di sé.
 *
 *   - già responsabile di sé (il server che si ricarica fa exec sul canale, stesso pid): execv, niente figlio;
 *   - altrimenti: figlio con disclaim e POSIX_SPAWN_SETSID (jcode server stop segnala il gruppo -pid del server),
 *     poi si resta ad aspettarlo e si esce col suo codice, come se il server fosse partito direttamente;
 *   - argv[0] del server diventa il percorso della copia firmata: in ps il server e il lanciatore si distinguono;
 *   - per `serve` toglie JCODE_NON_INTERACTIVE, che `jcode acp` imposta per sé e il server erediterebbe.
 *
 * Build: clang -O2 -o ~/.jcode/signed/server-launch server-launch.c (install.sh)
 */
#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
/* SPI di libSystem, macOS 10.14+, senza header pubblico */
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);
pid_t responsibility_get_pid_responsible_for_pid(pid_t pid);

int main(int argc, char **argv) {
  char self[PATH_MAX], real[PATH_MAX], target[PATH_MAX];
  uint32_t size = sizeof(self);
  if (_NSGetExecutablePath(self, &size) != 0 || !realpath(self, real)) {
    fprintf(stderr, "server-launch: non trovo il mio percorso\n");
    return 127;
  }
  snprintf(target, sizeof(target), "%s/jcode", dirname(real));

  for (int i = 1; i < argc; i++)
    if (strcmp(argv[i], "serve") == 0) unsetenv("JCODE_NON_INTERACTIVE");
  argv[0] = target;

  if (responsibility_get_pid_responsible_for_pid(getpid()) == getpid()) {
    execv(target, argv);
    fprintf(stderr, "server-launch: execv %s: %s\n", target, strerror(errno));
    return 127;
  }

  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSID);
  responsibility_spawnattrs_setdisclaim(&attr, 1);
  pid_t pid;
  int rc = posix_spawn(&pid, target, NULL, &attr, argv, environ);
  posix_spawnattr_destroy(&attr);
  if (rc != 0) {
    fprintf(stderr, "server-launch: posix_spawn %s: %s\n", target, strerror(rc));
    return 127;
  }
  /* JCODE_READY_FD (il byte di «pronto» che il client aspetta) passa al server così com'è; se il server muore prima,
     usciamo anche noi e il client vede EOF subito */
  int status;
  while (waitpid(pid, &status, 0) < 0)
    if (errno != EINTR) return 127;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
