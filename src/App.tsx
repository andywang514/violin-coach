import { useState } from 'react'
import './App.css'
import Tuner from './components/Tuner'
import SheetViewer from './components/SheetViewer'
import KaraokePractice from './components/KaraokePractice'

type Tab = 'practice' | 'tuner' | 'viewer'

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('practice')

  return (
    <div className="app">
      <header className="app-header">
        <h1>Violin Coach</h1>
        <nav className="tab-nav">
          <button 
            className={`tab-button ${activeTab === 'practice' ? 'active' : ''}`}
            onClick={() => setActiveTab('practice')}
          >
            Practice
          </button>
          <button 
            className={`tab-button ${activeTab === 'tuner' ? 'active' : ''}`}
            onClick={() => setActiveTab('tuner')}
          >
            Tuner
          </button>
          <button 
            className={`tab-button ${activeTab === 'viewer' ? 'active' : ''}`}
            onClick={() => setActiveTab('viewer')}
          >
            Sheet Viewer
          </button>
        </nav>
      </header>
      
      <main className="app-main">
        {activeTab === 'practice' && <KaraokePractice />}
        {activeTab === 'tuner' && <Tuner />}
        {activeTab === 'viewer' && <SheetViewer />}
      </main>
    </div>
  )
}
