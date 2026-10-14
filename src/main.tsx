import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { useI18n } from './i18n'

// M12：启动时同步 <html lang>，便于浏览器与无障碍工具识别
try {
  document.documentElement.lang = useI18n.getState().lang
} catch {
  /* ignore */
}

const root = document.getElementById('root')
if (!root) throw new Error('应用启动失败：缺少 #root 容器')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
