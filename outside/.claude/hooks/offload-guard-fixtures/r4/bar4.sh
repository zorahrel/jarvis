#!/bin/zsh
# copia ridotta di bar4.sh (24/10, round 4 di #427): migliaia di `bun test` da 2,5 s, quattro corsie, scorciatoie esportate
zmodload zsh/datetime
L=${0:a:h}; S=$L/..; B=$S/bin/bun; OUT=$L/bar4; mkdir -p $OUT
export OFFLOAD=local TOPICS_GATE_SLOTS=0
load1() { sysctl -n vm.loadavg | awk '{print $2}'; }
calm() { while (( $(load1 | cut -d. -f1) >= 35 )); do sleep 15; done; }
run() {
  calm
  out=$(cd $1 && python3 $S/bin/capped.py 2048 120 -- $B test --timeout 30000 $2 2>&1); rc=$?
  printf '%s\t%s\n' $1 $rc >> $OUT/runs.tsv
}
lanes() { local p=(); for ((q=1;q<=4;q++)); do ( for ((i=1;i<=$2;i++)); do run $1 ./x.test.ts; done ) & p+=($!); done; wait $p }
lanes /tmp/w 100
