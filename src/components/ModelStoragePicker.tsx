import { useEffect, useRef, useState } from 'react'
import { HttpProviderSettingsClient } from '../analysis/providerSettingsClient'

interface Storage { directory: string; browsing: string; parent: string; configured: string; folders: { name: string; path: string }[]; drives: string[]; freeBytes: number; canChange: boolean; externalEngine: boolean }
const decoder = { parse(value: unknown) { const info = value as Storage; if (typeof info?.directory !== 'string' || !Array.isArray(info.folders) || !Array.isArray(info.drives) || !Number.isFinite(info.freeBytes)) throw new Error(); return info } }
export default function ModelStoragePicker({ running }: { running: boolean }) {
  const [info, setInfo] = useState<Storage>()
  const [directory, setDirectory] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    void new HttpProviderSettingsClient().localOperation('/local-models/storage', 'GET', decoder, controller.signal).then((result) => { if (!controller.signal.aborted) { setInfo(result); setDirectory(result.configured) } }).catch(() => {})
    return () => controller.abort()
  }, [running])
  const read = async (path: string, save = false) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await new HttpProviderSettingsClient().localOperation('/local-models/storage', 'POST', decoder, lifetime.current.signal, { directory: path, save })
      setInfo(result); setDirectory(result.directory)
      if (save) setNotice('模型目录已保存。启动本机引擎后，新下载使用这个目录；原目录的模型不会自动搬移。')
    } catch { if (!lifetime.current.signal.aborted) setError('暂时无法读取或保存目录。请检查本地服务、目录权限，并先停止本机引擎。') }
    finally { setBusy(false) }
  }
  return <details className="model-storage-picker" open><summary>模型存储位置</summary>
    {info && <><p>{info.externalEngine ? '检测到外部引擎：实际目录由其设置决定。更换前请自行退出外部 Ollama，再由猫思之启动。' : `本软件启动引擎时使用：${info.configured}`}</p><p>当前浏览磁盘可用空间：{(info.freeBytes / 1024 ** 3).toFixed(1)} GB</p></>}
    <label>模型文件夹<input aria-label="模型文件夹" value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="选择磁盘与文件夹，或填写完整路径"/></label>
    <div className="storage-actions">{info?.drives.map((drive) => <button type="button" className="tbtn" disabled={busy} key={drive} onClick={() => { void read(drive) }}>{drive}</button>)}</div>
    <button type="button" className="tbtn" disabled={busy || !directory.trim()} onClick={() => { void read(directory) }}>浏览此文件夹</button>
    {info && <><p>浏览中：{info.browsing}</p><button type="button" className="tbtn" disabled={busy || info.parent === info.browsing} onClick={() => { void read(info.parent) }}>上一级</button><div className="storage-folders">{info.folders.map((folder) => <button type="button" className="tbtn" disabled={busy} key={folder.path} onClick={() => { void read(folder.path) }}>{folder.name}</button>)}</div></>}
    <button type="button" className="tbtn" disabled={busy || running || !directory.trim()} onClick={() => { void read(directory, true) }}>使用这个模型文件夹</button>
    {running && <p>更改目录前请先停止引擎；只停止本软件启动的进程。已有模型不自动迁移。</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </details>
}
