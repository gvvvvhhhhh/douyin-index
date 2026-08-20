# -*- coding: utf-8 -*-
"""测量首页（无筛选）路径耗时：rows 走索引 vs COUNT(EXISTS files)。只读。"""
import os
import sqlite3
import time

DB = os.path.join(os.environ["APPDATA"], "com.douyin.index", "douyin-index.sqlite")
conn = sqlite3.connect("file:%s?mode=ro&immutable=1" % DB.replace("\\", "/"), uri=True)
cur = conn.cursor()

EXISTS = "EXISTS (SELECT 1 FROM files f WHERE f.work_id = w.id)"

t0 = time.time()
rows = cur.execute(
    "SELECT w.* FROM works w WHERE %s ORDER BY w.publish_time DESC NULLS LAST LIMIT 100 OFFSET 0" % EXISTS
).fetchall()
print("rows LIMIT100 (index walk): %.3fs -> %d rows" % (time.time() - t0, len(rows)))

t0 = time.time()
n = cur.execute("SELECT COUNT(*) FROM works w WHERE %s" % EXISTS).fetchone()[0]
print("COUNT with EXISTS: %.3fs -> %d" % (time.time() - t0, n))

t0 = time.time()
files = cur.execute(
    "SELECT * FROM files WHERE work_id IN (%s) ORDER BY work_id, seq, filename"
    % ",".join(str(r[0]) for r in rows)
).fetchall()
print("files for 100 works: %.3fs -> %d" % (time.time() - t0, len(files)))

conn.close()
