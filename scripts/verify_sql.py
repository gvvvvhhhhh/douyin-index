# 临时验证脚本：验证标签统计 CTE 的语法、正确性与性能（只读查询）
import os
import sqlite3
import time

DB = os.path.join(os.environ["APPDATA"], "com.douyin.index", "douyin-index.sqlite")

conn = sqlite3.connect(DB)
cur = conn.cursor()

# 数据规模
for sql in [
    "SELECT COUNT(*) FROM works",
    "SELECT COUNT(*) FROM works WHERE topics IS NOT NULL AND topics != ''",
    "SELECT COUNT(*) FROM works WHERE hidden_tags IS NOT NULL AND hidden_tags != ''",
    "SELECT COUNT(*) FROM files",
]:
    print(sql, "=>", cur.execute(sql).fetchone()[0])

# 与旧 JS 逻辑等价性的基准数据（取前 200 条 topics）
rows = cur.execute(
    "SELECT topics FROM works WHERE topics IS NOT NULL AND topics != '' LIMIT 200"
).fetchall()

# 新 CTE（与 db.ts TAG_COUNT_SQL 完全一致）
CTE = """
WITH RECURSIVE split(tag, rest) AS (
  SELECT '', replace(replace(replace({col}, char(9), ' '), char(10), ' '), char(13), ' ') || ' '
  FROM works
  WHERE {col} IS NOT NULL AND {col} != ''
  UNION ALL
  SELECT
    ltrim(
      substr(rest, 1, CASE WHEN instr(rest, ' ') > 0 THEN instr(rest, ' ') - 1 ELSE LENGTH(rest) END),
      '#'
    ),
    CASE WHEN instr(rest, ' ') > 0 THEN substr(rest, instr(rest, ' ') + 1) ELSE '' END
  FROM split
  WHERE rest <> ''
)
SELECT tag AS name, COUNT(*) AS count FROM split WHERE tag <> '' GROUP BY tag ORDER BY count DESC
"""

# 1) 在 200 行样本上对比 CTE 结果与 Python 参考实现（对齐旧 JS /\s+/ + strip # 语义）
import re

sample = [r[0] for r in rows]
cur.execute(
    "CREATE TEMP TABLE sample_works (topics TEXT)"
)
cur.executemany("INSERT INTO sample_works VALUES (?)", [(s,) for s in sample])

ref = {}
for s in sample:
    for p in re.split(r"\s+", s):
        tag = re.sub(r"^#+", "", p).strip()
        if tag:
            ref[tag] = ref.get(tag, 0) + 1

sample_cte = CTE.replace("FROM works\n  WHERE", "FROM sample_works\n  WHERE").format(col="topics")
got = dict(cur.execute(sample_cte).fetchall())

assert got == ref, f"MISMATCH!\n only-in-cte={ {k: got[k] for k in got if k not in ref} }\n only-in-ref={ {k: ref[k] for k in ref if k not in got} }"
print("✓ CTE 与参考实现一致（200 条样本，", len(ref), "个标签）")

# 2) 全库执行计划（验证走索引而非全表扫描）
ep = cur.execute("EXPLAIN QUERY PLAN " + CTE.format(col="topics")).fetchall()
print("topics 执行计划:", ep)
ep2 = cur.execute("EXPLAIN QUERY PLAN " + CTE.format(col="hidden_tags")).fetchall()
print("hidden_tags 执行计划:", ep2)

# 3) 全库真实计时（topics）
t0 = time.time()
res = cur.execute(CTE.format(col="topics")).fetchall()
print(f"✓ topics 全库统计: {len(res)} 个标签, 耗时 {time.time()-t0:.1f}s, Top3: {res[:3]}")

t0 = time.time()
res2 = cur.execute(CTE.format(col="hidden_tags")).fetchall()
print(f"✓ hidden_tags 全库统计: {len(res2)} 个标签, 耗时 {time.time()-t0:.1f}s")

# 4) getWorks 新查询的执行计划
ep3 = cur.execute(
    "EXPLAIN QUERY PLAN SELECT w.* FROM works w WHERE EXISTS (SELECT 1 FROM files f WHERE f.work_id = w.id) ORDER BY w.publish_time DESC NULLS LAST LIMIT 100 OFFSET 0"
).fetchall()
print("getWorks 执行计划:", ep3)

conn.close()
print("ALL OK")
