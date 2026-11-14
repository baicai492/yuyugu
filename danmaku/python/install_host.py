"""注册 Native Messaging 宿主，让插件点「开始托管」时自动拉起本地识别服务。

    python python/install_host.py                  自动从 Chrome/Edge 的扩展列表里找 ID
    python python/install_host.py --ext-id=<ID>    手动指定扩展 ID
    python python/install_host.py --print          只看会做什么，不写注册表
    python python/install_host.py --uninstall      撤销

扩展 ID 在 chrome://extensions 里（打开开发者模式后可见）；插件面板连不上时
也会把自己的 ID 显示出来。自动查找靠读浏览器 Preferences 里记录的加载路径，
路径正好是本 danmaku 目录的那条就是。

做三件事：
  1. 生成 native/com.baicai492.danmaku.json（Chrome 读的宿主清单）
  2. 把清单路径写进 HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts
     （顺带 Edge 的同名键）
  3. 跑一次宿主自检，确认端口探测正常
"""
import glob
import json
import os
import subprocess
import sys
import winreg

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # danmaku/
NATIVE_DIR = os.path.join(ROOT, 'native')
HOST_NAME = 'com.baicai492.danmaku'
HOST_BAT = os.path.join(NATIVE_DIR, 'danmaku-host.bat')
HOST_PY = os.path.join(HERE, 'native_host.py')
MANIFEST = os.path.join(NATIVE_DIR, HOST_NAME + '.json')


def reg_path(edge=False):
    """相对于 HKEY_CURRENT_USER 的键路径。

    注意 winreg 的根键已经由参数给出，这里**不能**再带 `HKCU\\` 前缀，
    否则会写成 HKCU\\HKCU\\Software\\...，Chrome 读不到。
    """
    base = ('Software\\Microsoft\\Edge\\NativeMessagingHosts' if edge
            else 'Software\\Google\\Chrome\\NativeMessagingHosts')
    return base + '\\' + HOST_NAME


def reg_display(edge=False):
    return 'HKCU\\' + reg_path(edge)


def _cleanup_legacy():
    """清掉早期版本误写进 HKCU\\HKCU\\... 的键（那版把根键写进了路径）。"""
    for edge in (False, True):
        leaf = 'HKCU\\' + reg_path(edge)
        for key in (leaf, 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
                    'HKCU\\Software\\Google\\Chrome', 'HKCU\\Software\\Google',
                    'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
                    'HKCU\\Software\\Microsoft\\Edge', 'HKCU\\Software\\Microsoft',
                    'HKCU\\Software', 'HKCU'):
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
            except OSError:
                pass          # 不存在或非空，跳过


def find_python():
    for p in (sys.executable, r'D:\miniconda\envs\py311\python.exe'):
        if p and os.path.exists(p):
            return p
    return 'python'


def _norm(p):
    return os.path.normcase(os.path.abspath(p)).rstrip('\\/')


def _load_pref(path):
    """Chrome 的 Preferences 偶尔带尾巴（不是严格 JSON），raw_decode 更宽容。"""
    try:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            text = f.read()
    except OSError:
        return None
    try:
        return json.JSONDecoder().raw_decode(text)[0]
    except ValueError:
        return None


def guess_ext_id():
    """从浏览器偏好设置里找「加载路径正好是这个 danmaku 目录」的扩展。

    未打包扩展的 ID 由目录绝对路径算出来，稳定；浏览器把它记在
    extensions.settings[ID].path 里，所以能反查。

    注意新版 Chrome 把扩展设置放在 **Secure Preferences** 里，
    `Preferences` 里的 settings 是空的——两个都要看。
    找不到就返回空串。
    """
    want = _norm(ROOT)
    base = os.path.expandvars(r'%LOCALAPPDATA%')
    browsers = (('Chrome', os.path.join(base, 'Google', 'Chrome', 'User Data')),
                ('Edge', os.path.join(base, 'Microsoft', 'Edge', 'User Data')))
    for name, root in browsers:
        if not os.path.isdir(root):
            continue
        for fn in ('Secure Preferences', 'Preferences'):
            for pref in glob.glob(os.path.join(root, '*', fn)):
                data = _load_pref(pref)
                if not data:
                    continue
                settings = (data.get('extensions') or {}).get('settings') or {}
                for eid, v in settings.items():
                    if not isinstance(v, dict):
                        continue
                    p = v.get('path')
                    if p and _norm(p) == want:
                        return eid, name
    return '', ''


def write_manifest(ext_id):
    os.makedirs(NATIVE_DIR, exist_ok=True)
    manifest = {
        'name': HOST_NAME,
        'description': '斗法托管：启动本地 Python 识别服务',
        'path': HOST_BAT,
        'type': 'stdio',
        'allowed_origins': ['chrome-extension://%s/' % ext_id] if ext_id else [],
    }
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return manifest


def register(manifest_path):
    _cleanup_legacy()               # 先清掉早期版本写错位置的键
    ok = []
    for edge in (False, True):
        key = reg_path(edge)
        try:
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_WRITE) as k:
                winreg.SetValueEx(k, '', 0, winreg.REG_SZ, manifest_path)
            ok.append(('Edge' if edge else 'Chrome', True, reg_display(edge)))
        except OSError as e:
            ok.append(('Edge' if edge else 'Chrome', False, str(e)))
    return ok


def unregister():
    _cleanup_legacy()
    for edge in (False, True):
        key = reg_path(edge)
        try:
            # 键不存在时 DeleteKey 会抛错，当作已删除
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
            print('已删除：' + reg_display(edge))
        except OSError:
            print('本来就没有：' + reg_display(edge))
    for p in (MANIFEST,):
        try:
            os.remove(p)
            print('已删除：' + p)
        except OSError:
            pass


def self_test():
    try:
        out = subprocess.run([find_python(), HOST_PY, '--self-test', '8799'],
                             capture_output=True, timeout=10)
        # native_host 的 stdout 是二进制协议通道，自检模式下是明文 JSON
        text = (out.stdout or b'').decode('utf-8', 'replace').strip()
        print('宿主自检：' + (text or ('退出码 %d' % out.returncode)))
    except Exception as e:                          # noqa: BLE001
        print('宿主自检失败：' + str(e))


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:                                # noqa: BLE001
        pass

    args = sys.argv[1:]
    if '--uninstall' in args:
        unregister()
        return

    ext_id = ''
    for a in args:
        if a.startswith('--ext-id='):
            ext_id = a.split('=', 1)[1].strip()

    auto_note = ''
    if not ext_id:
        ext_id, browser = guess_ext_id()
        if ext_id:
            auto_note = '（自动从 %s 的扩展列表里找到）' % browser

    manifest = write_manifest(ext_id)
    print('已生成宿主清单：' + MANIFEST)

    if not ext_id:
        print('\n⚠ 还缺扩展 ID。可能是扩展还没加载。步骤：')
        print('  1. Chrome → chrome://extensions → 打开「开发者模式」')
        print('  2. 「加载已解压的扩展程序」→ 选 ' + ROOT)
        print('  3. 重新运行本脚本（会自动认出来），或加 --ext-id=<那个ID>')
        print('\n（插件面板连不上时也会显示自己的 ID，直接复制也行）')
        sys.exit(2)

    print('扩展 ID：%s%s' % (ext_id, auto_note))
    if '--print' in args:
        print('\n将写入注册表：')
        print('  ' + reg_display(False) + ' = ' + MANIFEST)
        print('  ' + reg_display(True) + ' = ' + MANIFEST)
        return

    for name, ok, info in register(MANIFEST):
        print(('✓ 已注册到 %s' % name) if ok else ('✗ %s 失败：%s' % (name, info)))

    self_test()
    print('\n完成。现在点插件里的「开始托管」，会自动拉起本地服务。')


if __name__ == '__main__':
    main()
