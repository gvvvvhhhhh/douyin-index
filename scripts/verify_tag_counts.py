# -*- coding: utf-8 -*-
"""验证 tag_counts 物化表方案：只读 ATTACH 真实库，结果写入临时库，不动真实数据库。"""
import os
import re
import sqlite3
import tempfile
import time

REAL_DB = os.path.join(os.environ["APPDATA"], "com.douyin.index", "douyin-index.sqlite")

CTE_BODY = """
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
"""

REBUILD = """
WITH RECURSIVE split(tag, rest) AS ({body})
INSERT INTO tag_counts (tag, is_hidden, count)
SELECT tag, {is_hidden}, COUNT(*) FROM split WHERE tag <> '' GROUP BY tag
"""


def main():
    tmp = os.path.join(tempfile.gettempdir(), "tag_counts_verify.sqlite")
    if os.path.exists(tmp):
        os.remove(tmp)
    conn = sqlite3.connect("file:" + tmp.replace("\\", "/") + "?mode=rwc", uri=True)
    conn.execute(
        "ATTACH DATABASE 'file:%s?mode=ro&immutable=1' AS real" % REAL_DB.replace("\\", "/")
    )
    cur = conn.cursor()
    cur.execute(
        """CREATE TABLE tag_counts (
          tag TEXT NOT NULL,
          is_hidden INTEGER NOT NULL DEFAULT 0,
          count INTEGER NOT NULL,
          PRIMARY KEY (is_hidden, tag)
        ) WITHOUT ROWID"""
    )
    cur.execute("CREATE INDEX idx_tag_counts_hidden_count ON tag_counts(is_hidden, count DESC)")
    cur.execute("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

    t0 = time.time()
    for col, hidden in (("topics", 0), ("hidden_tags", 1)):
        cur.execute(REBUILD.format(body=CTE_BODY.format(col=col), is_hidden=hidden).replace("FROM works", "FROM real.works"))
    print("rebuild elapsed: %.1fs" % (time.time() - t0))

    n_works = cur.execute("SELECT COUNT(*) FROM real.works").fetchone()[0]
    cur.execute(
        "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('tag_counts_works', ?)", (str(n_works),)
    )

    t0 = time.time()
    top = cur.execute(
        "SELECT tag, count FROM tag_counts WHERE is_hidden = ? ORDER BY count DESC LIMIT ?", (0, 500)
    ).fetchall()
    q1 = time.time() - t0
    total = cur.execute("SELECT COUNT(*) FROM tag_counts WHERE is_hidden = 0").fetchone()[0]
    print("top500 query: %.3fs, total topics=%d" % (q1, total))
    print("top5:", top[:5])

    t0 = time.time()
    hits = cur.execute(
        "SELECT tag, count FROM tag_counts WHERE is_hidden = ? AND tag LIKE ? ORDER BY count DESC LIMIT ?",
        (0, "%治愈%", 500),
    ).fetchall()
    q2 = time.time() - t0
    matched = cur.execute(
        "SELECT COUNT(*) FROM tag_counts WHERE is_hidden = ? AND tag LIKE ?", (0, "%治愈%")
    ).fetchone()[0]
    print("search query: %.3fs, matched=%d, top3=%s" % (q2, matched, hits[:3]))

    # 与 JS 参考实现对账（抽样 2 万行，/\s+/ split + 去 # 前缀）
    sample = [
        r[0]
        for r in cur.execute(
            "SELECT topics FROM real.works WHERE topics IS NOT NULL AND topics != '' LIMIT 20000"
        ).fetchall()
    ]
    ref = {}
    for s in sample:
        for p in re.split(r"\s+", s):
            tag = re.sub(r"^#+", "", p).strip()
            if tag:
                ref[tag] = ref.get(tag, 0) + 1
    got = dict(
        cur.execute(
            "WITH RECURSIVE split(tag, rest) AS (%s) SELECT tag, COUNT(*) FROM split WHERE tag <> '' GROUP BY tag"
            % CTE_BODY.format(col="topics").replace(
                "FROM works",
                "FROM (SELECT topics FROM real.works WHERE topics IS NOT NULL AND topics != '' LIMIT 20000)",
            )
        ).fetchall()
    )
    assert got == ref, "MISMATCH! only-in-cte=%s only-in-ref=%s" % (
        {k: got[k] for k in got if k not in ref},
        {k: ref[k] for k in ref if k not in got},
    )
    print("CTE vs JS-reference: MATCH (20k rows sample)")

    conn.close()
    os.remove(tmp)
    print("done, temp db removed")


if __name__ == "__main__":
    main()
