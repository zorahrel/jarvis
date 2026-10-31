#!/usr/bin/perl
# Cerca in un testo (stdin) i lavori pesanti di heavy.ere. Lo usa offload-guard.sh al posto di un grep per regola.
#
#   perl heavy-scan.pl <heavy.ere> cmd|body|raw|strip < testo
#   cmd    comando di una sessione: conta solo ciò che è IN POSIZIONE DI COMANDO (vedi sotto); i bypass sono ignorati
#   body   corpo di uno script di shell: come cmd, e in più i bypass (OFFLOAD=local, TOPICS_GATE_SLOTS=0) ovunque
#   raw    nessun filtro (sorgenti non di shell, parità col traduttore JS del hub): tutte le regole start|both, bypass compresi
#   strip  stampa le frasi di comando non avvolte, una per riga: serve a trovare gli script lanciati
#   uscita: una riga «classe<TAB>testo» per regola presa. Qualunque guasto: nessuna uscita (l'hook lascia passare).
#
# Perché la posizione: lo stesso grep sul testo intero fermava `git commit -m "fix jest"`, `man eslint`, `which tsc`,
# `echo "poi lancia npm test"`, `brew info ffmpeg`: parole di uno strumento in mezzo ai suoi argomenti (verifica del 24/10, a
# carico 2,5-3,2 per core). Una regola vale solo se il match comincia nel PRIMO pezzo della frase di comando, cioè dopo
# separatori (; & | ( ) ` a capo), assegnazioni, parole di controllo (then, do, time, nice, timeout, env, sudo, xargs, watch, lockf...)
# e lanciatori (npx; pnpm/yarn/bun/npm che portano a un eseguibile: `pnpm vitest`, `bun run vitest`, `npm exec -- tsc`; uv run,
# python -m), anche in catena (`nice -n 10 pnpm exec vitest`). Dopo un interprete (bash, node, python...) vale anche il primo argomento
# che non è un'opzione, perché `bash run-axes.sh` è il comando. `bash -c "..."`, `eval "..."` e `python3 -c "..."` si
# aprono: dentro c'è un comando vero.
# Una frase che comincia con offload, pw-remote o il lancio di un agente (codex, claude, muse, delegate, jcode...) è AVVOLTA e
# si butta: il comando dentro gira altrove o ha il suo hook (il prompt di `codex exec "...npm test"` non è lavoro pesante).
use strict;
use warnings;

my ($rulesf, $mode) = @ARGV;
exit 0 unless defined $rulesf && defined $mode;
local $SIG{__DIE__} = sub { exit 0 };

my @rules;
if (open(my $fh, '<', $rulesf)) {
  while (my $l = <$fh>) {
    chomp $l;
    next if $l =~ /^\s*(#|$)/;
    my ($cls, $where, $ere) = split /\t/, $l, 3;
    next unless defined $ere && length $ere;
    my $re = eval { qr/$ere/ };
    next unless $re;
    push @rules, { cls => $cls, where => $where, re => $re };
  }
  close $fh;
}
my $text = do { local $/; my $t = <STDIN>; defined $t ? $t : '' };

my @hits;
my %seen;
sub hit {
  my ($cls, $txt) = @_;
  $txt =~ s/^[\s"'\/]+|[\s"';)|&]+$//g;
  return if $seen{"$cls\t$txt"}++;
  push @hits, "$cls\t$txt";
}
sub applies { my $r = shift; return $r->{where} eq 'start' || $r->{where} eq 'both' }

if ($mode eq 'raw') {
  for my $r (@rules) { next unless applies($r); hit($r->{cls}, $&) if $text =~ $r->{re}; }
  print "$_\n" for @hits;
  exit 0;
}

my %WRAP = map { $_ => 1 } qw(offload pw-remote codex claude muse museagent codexagent delegate jcode cloud-lancia);
my %INTERP = map { $_ => 1 } qw(bash sh zsh dash ksh python python3 node bun deno ruby perl tsx);
my $QSTR = qr/"(?:[^"\\]|\\.)*"|'[^']*'/;
# Lanciatori di pacchetti: portano a un eseguibile (`pnpm vitest run`, `bun --bun run vitest`, `yarn exec jest`, `npm exec -- tsc`).
# Il vecchio hook cercava la parola ovunque e li fermava: qui lo strumento comincia la frase solo dopo il lanciatore, che si salta.
# Opzioni con valore (--filter web, -C dir, -p pkg) o senza (--, -y, --bun, -r). `npm` da solo non lancia binari: solo con run/exec/x.
my $OPT = qr/(?:--?(?:filter|F|C|dir|prefix|cwd|workspace|package|p)\s+\S+\s+|-\S*\s+)/;
my $PKG = qr{^(?:\S*/)?(?:(?:npm|pnpm|yarn|bun)(?=\s)\s+$OPT*(?:run|run-script|exec|dlx|x)(?=\s)\s+|(?:pnpm|yarn|bun)(?=\s)\s+)$OPT*};

# separa in frasi ai separatori fuori dalle virgolette
sub split_segments {
  my ($t) = @_;
  my (@segs, $cur, $q);
  ($cur, $q) = ('', '');
  my $n = length $t;
  for (my $i = 0; $i < $n; $i++) {
    my $c = substr($t, $i, 1);
    if ($q ne '') {
      $cur .= $c;
      if ($c eq '\\' && $q eq '"' && $i + 1 < $n) { $cur .= substr($t, ++$i, 1); next }
      $q = '' if $c eq $q;
      next;
    }
    if ($c eq '\\' && $i + 1 < $n) { $cur .= $c . substr($t, ++$i, 1); next }
    if ($c eq '"' || $c eq "'") { $q = $c; $cur .= $c; next }
    if ($c eq '#' && ($cur eq '' || $cur =~ /\s$/)) {
      $i++ while $i < $n && substr($t, $i, 1) ne "\n";
      push @segs, $cur; $cur = ''; next;
    }
    if ($c =~ /[;&|()`\n]/) { push @segs, $cur; $cur = ''; next }
    $cur .= $c;
  }
  push @segs, $cur;
  return grep { /\S/ } @segs;
}
sub unquote {
  my ($s) = @_;
  if ($s =~ /^"(.*)"$/s) { my $x = $1; $x =~ s/\\(["\\\$`])/$1/g; return $x }
  if ($s =~ /^'(.*)'$/s) { return $1 }
  return $s;
}

# frasi di comando: [testo, finestra, grezza?]
sub phrases {
  my ($t, $depth, $out) = @_;
  return if $depth > 4;
  command_phrase($_, $depth, $out) for split_segments($t);
}

# una frase: si tolgono le parole che precedono il comando, poi si decide cosa farne. Vale 1 se la frase è avvolta (e si butta), se no 0.
sub command_phrase {
  my ($s, $depth, $out) = @_;
  return 0 if $depth > 4;
  $s =~ s/^\s+//;
  for (my $guard = 0; $guard < 40; $guard++) {
    my $before = $s;
    $s =~ s/^["']+//;
    $s =~ s/^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S*)\s*//;
    $s =~ s/^(?:export|declare|local|readonly)\s+//;
    $s =~ s/^(?:if|then|else|elif|do|while|until|!|\{|exec|command|builtin|nohup|setsid)(?=\s)\s*//;
    # i lanciatori possono avere il percorso davanti (/usr/bin/time, /usr/bin/env) e opzioni (/usr/bin/time -l, nice -n 10, watch -n 5)
    $s =~ s/^(?:\S*\/)?time(?=\s)\s+(?:(?:-o|-f)\s+\S+\s+|-\S+\s+)*//;
    $s =~ s/^(?:\S*\/)?nice(?=\s)\s+(?:-n\s*-?\d+\s+|-\d+\s+)?//;
    $s =~ s/^(?:\S*\/)?timeout(?=\s)\s+(?:-\S+\s+)*\d+[smhd]?\s+//;
    $s =~ s/^(?:\S*\/)?env(?=\s)\s+(?:-\S+\s+|[A-Za-z_]\w*=\S*\s+)*//;
    $s =~ s/^(?:\S*\/)?sudo(?=\s)\s+(?:-u\s+\S+\s+|-\S+\s+)*//;
    $s =~ s/^(?:\S*\/)?caffeinate(?=\s)\s+(?:-t\s*\d+\s+|-\S+\s+)*//;
    $s =~ s/^(?:\S*\/)?watch(?=\s)\s+(?:(?:-n|--interval)\s*\S+\s+|-\S+\s+)*//;
    $s =~ s/^(?:\S*\/)?lockf(?=\s)\s+(?:-\S+\s+)*\S+\s+//;
    $s =~ s/^(?:\S*\/)?xargs(?=\s)\s+(?:-[A-Za-z]+\s*\d*\s+)*//;
    $s =~ s/^(?:\S*\/)?corepack(?=\s)\s+//;
    $s =~ s/^(?:\S*\/)?(?:npx|pnpx|bunx)(?=\s)\s+(?:(?:-p|--package)\s+\S+\s+|-\S+\s+)*//;
    $s =~ s/^(?:uv|poetry|pipenv|pdm)\s+run\s+(?:-\S+\s+)*//;
    $s =~ s/^(?:\S*\/)?python3?\s+-m\s+//;
    $s =~ s/^\s+//;
    last if $s eq $before;
  }
  return 0 unless $s =~ /\S/;
  my ($first) = $s =~ /^(\S+)/;
  (my $base = $first) =~ s{^.*/}{};
  return 1 if $WRAP{$base};   # avvolta: gira altrove o ha il suo hook
  # payload di una shell o di eval: un comando vero
  if ($s =~ /^(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)\s+(?:-[A-Za-z-]+\s+)*?-[A-Za-z]*c[A-Za-z]*\s+($QSTR)/) {
    phrases(unquote($1), $depth + 1, $out); return 0;
  }
  if ($s =~ /^eval\s+($QSTR)/) { phrases(unquote($1), $depth + 1, $out); return 0 }
  # codice dato a un interprete: lì dentro conta anche il testo grezzo
  if ($s =~ /^(?:\S*\/)?(?:python3?|node|bun|deno|ruby|perl)\s+(?:-\S+\s+)*?(?:-c|-e|-p|--eval)\s+($QSTR)/) {
    push @$out, [unquote($1), 0, 1]; return 0;
  }
  # lanciatore di pacchetti: la frase intera resta (`pnpm build`, `npm test` sono regole), e in più si guarda cosa lancia
  # (se è avvolto, `pnpm exec offload -- …`, si butta anche la frase intera)
  return 1 if $s =~ $PKG && command_phrase(substr($s, $+[0]), $depth + 1, $out);
  my $win = length $first;
  if ($INTERP{$base} && $s =~ /^(\S+(?:\s+-\S+)*\s+\S+)/) { $win = length $1 }
  push @$out, [$s, $win, 0];
  return 0;
}

my @ph;
phrases($text, 0, \@ph);

if ($mode eq 'strip') { print "$_->[0]\n" for grep { !$_->[2] } @ph; exit 0 }

for my $r (@rules) {
  next unless applies($r);
  next if $r->{cls} eq 'bypass';
  for my $p (@ph) {
    my ($s, $win, $raw) = @$p;
    if ($raw) { if ($s =~ $r->{re}) { hit($r->{cls}, $&); last } next }
    my $found;
    pos($s) = undef;
    while ($s =~ /$r->{re}/g) { if ($-[0] < $win) { $found = $&; last } }
    pos($s) = undef;
    if (defined $found) { hit($r->{cls}, $found); last }
  }
}
if ($mode eq 'body') {
  my $nocomment = join "\n", grep { !/^\s*#/ } split /\n/, $text;
  for my $r (@rules) { next unless applies($r) && $r->{cls} eq 'bypass'; hit('bypass', $&) if $nocomment =~ $r->{re}; }
}
print "$_\n" for @hits;
exit 0;
