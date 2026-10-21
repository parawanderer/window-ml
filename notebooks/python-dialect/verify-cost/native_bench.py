"""native_bench.py <reps> — one native process: prints {shape: [ns per call per rep]} as JSON (shapes.py).

Run with a native build's ./python.exe from this folder. The native rounds in data/native-*.jsonl were taken by an
earlier form of this script that printed each shape's min and median per process (2026-10-21, before the notebook).
"""
import json, sys
sys.path.insert(0, __import__("os").path.dirname(__file__))
from shapes import measure

print(json.dumps(measure(int(sys.argv[1]) if len(sys.argv) > 1 else 5)))
