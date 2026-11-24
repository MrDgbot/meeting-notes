"""pytest 公共配置：
1. 在任何业务模块导入前隔离 MEETING_DATA 到临时目录，避免测试污染仓库 data/；
2. 把仓库根目录加入 sys.path；
3. 自动给重量级集成测试文件（依赖 4GB 语音模型或子进程服务）打上 @pytest.mark.integration 标记，
   配合 pyproject.toml 的 addopts = ["-m", "not integration"]，默认 pytest 只跑快速单元测试；
4. 禁止 app.ambient 的 15 秒后台卡住巡检在单测期间误把测试夹具送进真实转写线程池导致退出卡死。
"""
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if "MEETING_DATA" not in os.environ:
    _SESSION_DATA = tempfile.mkdtemp(prefix="mn-pytest-")
    os.environ["MEETING_DATA"] = _SESSION_DATA
    atexit.register(shutil.rmtree, _SESSION_DATA, True)

INTEGRATION_FILES = {
    "test_live_resume.py",
    "test_lan_security.py",
    "test_diarize_offline.py",
}


def pytest_collection_modifyitems(config, items):
    mark = pytest.mark.integration
    for item in items:
        if item.path.name in INTEGRATION_FILES:
            item.add_marker(mark)


@pytest.fixture(scope="session", autouse=True)
def _disable_ambient_background_sweep():
    """单测进程不加载语音模型；若导入了 app，标记 _stuck_swept 防止 15s 后台巡检提交真实转写任务。"""
    app_mod = sys.modules.get("app")
    if app_mod is not None and hasattr(app_mod, "ambient"):
        app_mod.ambient._stuck_swept = True
    yield
    app_mod = sys.modules.get("app")
    if app_mod is not None:
        if hasattr(app_mod, "ambient"):
            app_mod.ambient._stuck_swept = True
        for pool_name in ("jobs", "minutes_jobs"):
            pool = getattr(app_mod, pool_name, None)
            if pool is not None and hasattr(pool, "shutdown"):
                pool.shutdown(wait=False, cancel_futures=True)
