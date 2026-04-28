import { useEffect } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { normalizeAzureResourceUrl, normalizeBaseUrl } from './lib/api'
import type { ApiMode, ApiProvider } from './types'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import LoginModal from './components/LoginModal'

export default function App() {
  const setSettings = useStore((s) => s.setSettings)

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings: {
      apiProvider?: ApiProvider
      baseUrl?: string
      apiKey?: string
      azureApiVersion?: string
      codexCli?: boolean
      apiMode?: ApiMode
    } = {
      codexCli: false,
      apiMode: 'images',
    }

    const apiProviderParam = searchParams.get('apiProvider')
    if (apiProviderParam === 'openai' || apiProviderParam === 'azure') {
      nextSettings.apiProvider = apiProviderParam
    }

    const apiUrlParam = searchParams.get('apiUrl')
    if (apiUrlParam !== null) {
      nextSettings.baseUrl = nextSettings.apiProvider === 'azure'
        ? normalizeAzureResourceUrl(apiUrlParam.trim())
        : normalizeBaseUrl(apiUrlParam.trim())
    }

    const apiKeyParam = searchParams.get('apiKey')
    if (apiKeyParam !== null) {
      nextSettings.apiKey = apiKeyParam.trim()
    }

    const azureApiVersionParam = searchParams.get('azureApiVersion')
    if (azureApiVersionParam !== null) {
      nextSettings.azureApiVersion = azureApiVersionParam.trim()
    }

    const codexCliParam = searchParams.get('codexCli')
    if (codexCliParam !== null) {
      nextSettings.codexCli = codexCliParam.trim().toLowerCase() === 'true'
    }

    const apiModeParam = searchParams.get('apiMode')
    if (apiModeParam === 'images' || apiModeParam === 'responses') {
      nextSettings.apiMode = apiModeParam
    }

    setSettings(nextSettings)

    if (searchParams.has('apiProvider') || searchParams.has('apiUrl') || searchParams.has('apiKey') || searchParams.has('azureApiVersion') || searchParams.has('codexCli') || searchParams.has('apiMode')) {
      searchParams.delete('apiProvider')
      searchParams.delete('apiUrl')
      searchParams.delete('apiKey')
      searchParams.delete('azureApiVersion')
      searchParams.delete('codexCli')
      searchParams.delete('apiMode')

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    initStore()
  }, [setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <>
      <Header />
      <main data-home-main className="safe-area-x max-w-7xl mx-auto pb-48">
        <SearchBar />
        <TaskGrid />
      </main>
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
      <LoginModal />
    </>
  )
}
