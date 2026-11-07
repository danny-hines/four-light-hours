"""Strip an HTML page (stdin) to plain text; optional args: keyword, before, after chars."""
import sys, re, html
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
t = sys.stdin.buffer.read().decode("utf-8", "replace")
t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S | re.I)
t = html.unescape(re.sub(r"<[^>]+>", " ", t))
t = re.sub(r"\s+", " ", t)
if len(sys.argv) > 1:
    kw = sys.argv[1]; b = int(sys.argv[2]) if len(sys.argv) > 2 else 500; a = int(sys.argv[3]) if len(sys.argv) > 3 else 1500
    for m in list(re.finditer(re.escape(kw), t, flags=re.I))[:3]:
        print("...", t[max(0, m.start() - b): m.start() + a], "...\n")
else:
    print(t)
