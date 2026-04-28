import { useEffect, useState } from 'react'
import { apiGet, apiPost } from '../lib/serverData'

export default function LoginModal() {
  const [authRequired, setAuthRequired] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiGet<{ authenticated: boolean; authRequired: boolean }>('/api/auth/status')
      .then((status) => {
        setAuthenticated(status.authenticated)
        setAuthRequired(status.authRequired)
      })
      .catch(() => {
        setAuthRequired(true)
        setAuthenticated(false)
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading || !authRequired || authenticated) return null

  const login = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await apiPost('/api/auth/login', { key })
      setAuthenticated(true)
      window.location.reload()
    } catch (error) {
      setError(error instanceof Error ? error.message : '登录失败')
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-950/70 p-4 backdrop-blur-sm">
      <form onSubmit={login} className="w-full max-w-sm rounded-3xl border border-white/50 bg-white/95 p-6 shadow-2xl dark:border-white/[0.08] dark:bg-gray-900/95">
        <h2 className="mb-2 text-lg font-semibold text-gray-800 dark:text-gray-100">登录</h2>
        <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">请输入部署时配置的访问密钥。</p>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          type="password"
          autoFocus
          className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
          placeholder="APP_LOGIN_KEY"
        />
        {error && <div className="mt-3 text-sm text-red-500">{error}</div>}
        <button className="mt-5 w-full rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600" type="submit">
          登录
        </button>
      </form>
    </div>
  )
}
