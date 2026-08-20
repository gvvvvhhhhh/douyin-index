# -*- coding: utf-8 -*-
"""测量无筛选首页加载路径耗时：rows 查询 + COUNT 总数。只读。"""
import os
import sqlite3
import time

DB = os.path.join(os.environ["APPDATA"], "com.douyin.index", "douyin-index.sqlite")
conn = sqlite3.connect("file:%s?mode=ro&immutable=1" % DB.replace("\\", "/"), uri=True)
cur = conn.cursor()
EXISTS = "EXISTS (SELECT 1 FROM files f WHERE f.work_id = w.id)"


def bench(label, sql):
    t0 = time.time()
    cur.execute(sql).fetchall()
    print("%-38s %.3fs" % (label, time.time() - t0))


# 1. 首页 rows（w.id，不含 IPC 传输成本）
bench("page1 rows (w.id)",
      "SELECT w.id FROM works w WHERE %s ORDER BY w.publish_time DESC NULLS LAST LIMIT 100" % EXISTS)
# 2. 首页 rows（w.* 全列，近似实际查询）
bench("page1 rows (w.*)",
      "SELECT w.* FROM works w WHERE %s ORDER BY w.publish_time DESC NULLS LAST LIMIT 100" % EXISTS)
# 3. 满页后的 COUNT（当前 getWorks 实际执行）
bench("COUNT(*) with EXISTS",
      "SELECT COUNT(*) AS c FROM works w WHERE %s" % EXISTS)
# 4. 纯 COUNT(*)（对照）
bench("COUNT(*) plain", "SELECT COUNT(*) FROM works")
# 5. publish_time 索引计数（对照）
bench("COUNT(publish_time)", "SELECT COUNT(publish_time) FROM works")

conn.close()
