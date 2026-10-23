"""python3 -m unittest server.test_muse_probe - stdlib only."""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
import muse_probe


def payload(used=25.0, resets_at=1791400000):
    return {"subs_usage": {"window": {"used_percent": used, "resets_at": resets_at}},
            "user_email": "ada@example.com"}


class CacheLogic(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = os.path.join(self.tmp.name, "subs.json")
        self.fail = os.path.join(self.tmp.name, "fail")
        self.p1 = mock.patch.object(muse_probe, "CACHE_PATH", self.cache)
        self.p2 = mock.patch.object(muse_probe, "FAIL_PATH", self.fail)
        self.p3 = mock.patch.object(muse_probe, "RETRY_DELAY", 0)
        self.p4 = mock.patch.object(muse_probe, "GOOD_PATH", os.path.join(self.tmp.name, "good.json"))
        self.p4.start()
        self.p5 = mock.patch.object(muse_probe, "HISTORY_PATH", os.path.join(self.tmp.name, "history.jsonl"))
        self.p5.start()
        self.p1.start()
        self.p2.start()
        self.p3.start()

    def tearDown(self):
        self.p1.stop()
        self.p2.stop()
        self.p3.stop()
        self.p4.stop()
        self.p5.stop()
        self.tmp.cleanup()

    def run_main(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            muse_probe.main()
        return json.loads(buf.getvalue())

    def test_fresh_cache_serves_without_token_or_net(self):
        muse_probe.save_cache(payload())
        with mock.patch.object(muse_probe, "read_token",
                               side_effect=AssertionError("no keychain")), \
             mock.patch.object(muse_probe, "fetch_subs",
                               side_effect=AssertionError("no net")):
            out = self.run_main()
        self.assertEqual(out["quotas"][0]["percentRemaining"], 75.0)
        self.assertEqual(out["email"], "ada@example.com")

    def test_failure_marks_quiet_and_serves_stale(self):
        with open(self.cache, "w") as f:  # cache vecchia di un giorno
            json.dump({"at": 1.0, "payload": payload()}, f)
        with mock.patch.object(muse_probe, "read_token", return_value=None):
            out = self.run_main()
        self.assertEqual(out["quotas"][0]["percentRemaining"], 75.0)
        self.assertEqual(out["asOf"], 1)  # la tray vede che è vecchio
        self.assertTrue(os.path.exists(self.fail))
        # secondo giro: non ritenta nemmeno il token (silenzio 15 min)
        with mock.patch.object(muse_probe, "read_token",
                               side_effect=AssertionError("retry!")):
            out2 = self.run_main()
        self.assertEqual(out2["quotas"][0]["percentRemaining"], 75.0)

    def test_success_clears_fail_flag(self):
        with open(self.fail, "w") as f:
            f.write("1.0")  # fallimento di ieri: scaduto, si riprova
        with mock.patch.object(muse_probe, "read_token", return_value="tok"), \
             mock.patch.object(muse_probe, "fetch_subs",
                               return_value=payload(used=10.0)):
            out = self.run_main()
        self.assertEqual(out["quotas"][0]["percentRemaining"], 90.0)
        self.assertFalse(os.path.exists(self.fail))

    def test_transient_token_miss_retries_once(self):
        with mock.patch.object(muse_probe, "read_token",
                               side_effect=[None, "tok"]), \
             mock.patch.object(muse_probe, "fetch_subs",
                               return_value=payload(used=101.0)):
            out = self.run_main()
        self.assertEqual(out["quotas"][0]["percentRemaining"], 0.0)
        self.assertFalse(os.path.exists(self.fail))

    def test_total_failure_prints_empty_quotas(self):
        with mock.patch.object(muse_probe, "read_token", return_value=None):
            out = self.run_main()
        self.assertEqual(out, {"quotas": [], "email": None})

    def test_mint_without_usage_serves_last_good_reading(self):
        week = {"used_percent": 28.0, "resets_at": 4000000000}
        gone = {"used_percent": 90.0, "resets_at": 1000}  # finestra già azzerata
        with mock.patch.object(muse_probe, "read_token", return_value="tok"), \
             mock.patch.object(muse_probe, "fetch_subs", return_value={
                 "subs_usage": {"weekly": week, "window": gone}, "user_email": "ada@example.com"}):
            self.run_main()
        os.unlink(self.cache)
        with mock.patch.object(muse_probe, "read_token", return_value="tok"), \
             mock.patch.object(muse_probe, "fetch_subs", return_value={"user_email": "ada@example.com"}):
            out = self.run_main()
        self.assertEqual([q["type"] for q in out["quotas"]], ["weekly"])
        self.assertEqual(out["quotas"][0]["percentRemaining"], 72.0)
        self.assertLess(out["asOf"], 4000000000)

    def test_no_good_reading_falls_back_to_history(self):
        now = muse_probe.time.time()
        with open(muse_probe.HISTORY_PATH, "w") as f:
            f.write(json.dumps({"t": now - 3600, "s": {"muse|ada@example.com|7d": 28}}) + "\n")
            f.write(json.dumps({"t": now - 60, "s": {"claude|x|7d": 5}}) + "\n")
        with mock.patch.object(muse_probe, "read_token", return_value="tok"), \
             mock.patch.object(muse_probe, "fetch_subs", return_value={"user_email": "ada@example.com"}):
            out = self.run_main()
        self.assertEqual(out["quotas"], [{"type": "weekly", "percentRemaining": 72.0}])
        self.assertEqual(out["asOf"], int(now - 3600))


if __name__ == "__main__":
    unittest.main()
