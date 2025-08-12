import { useCallback, useEffect, useRef, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'

export default function SheetViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)
  const [status, setStatus] = useState<string>('Load a score to begin')

  useEffect(() => {
    if (!containerRef.current) return
    if (!osmdRef.current) {
      osmdRef.current = new OpenSheetMusicDisplay(containerRef.current, {
        autoResize: true,
        drawingParameters: 'compacttight',
        renderSingleHorizontalStaffline: false,
        measureNumberInterval: 1,
        drawMeasureNumbers: true,
      })
    }
  }, [])

  const loadSample = useCallback(async () => {
    if (!osmdRef.current) return
    setStatus('Loading sample score...')
    const candidates = [
      '/scores/twinkle-twinkle.musicxml',
      '/scores/mary-had-a-little-lamb.musicxml',
      '/scores/open-strings.musicxml',
      '/scores/sample.musicxml',
      'https://opensheetmusicdisplay.github.io/demo/sheets/MuzioClementi_SonatinaOpus36_No1_Part1.xml',
      'https://opensheetmusicdisplay.github.io/demo/sheets/ScottJoplin_The_Entertainer.xml',
      'https://opensheetmusicdisplay.github.io/demo/sheets/OSMD_function_test_all.xml',
      'https://opensheetmusicdisplay.github.io/demo/sheets/Beethoven_AnDieFerneGeliebte_op98_No1.xml',
    ]
    let text = ''
    for (const url of candidates) {
      try {
        const res = await fetch(url)
        if (!res.ok) continue
        const t = await res.text()
        if (t.trim().startsWith('<?xml') || t.includes('<score-partwise') || t.includes('<score-timewise')) {
          text = t
          break
        }
      } catch {
        // try next
      }
    }
    if (!text) throw new Error('No sample could be loaded')
    await osmdRef.current.load(text)
    await osmdRef.current.render()
    setStatus('Sample loaded successfully')
  }, [])

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !osmdRef.current) return
    
    const reader = new FileReader()
    reader.onload = async (e) => {
      const text = e.target?.result as string
      if (!text) return
      
      try {
        setStatus('Loading custom file...')
        await osmdRef.current!.load(text)
        await osmdRef.current!.render()
        setStatus('File loaded successfully')
      } catch (error) {
        setStatus('Error loading file')
        console.error(error)
      }
    }
    reader.readAsText(file)
  }, [])

  return (
    <div className="component-container">
      <h2 className="component-title">Sheet Music Viewer</h2>
      
      <div className="file-upload">
        <input
          type="file"
          id="sheet-musicxml-file"
          accept=".xml,.musicxml"
          className="file-input"
          onChange={handleFileUpload}
        />
        <label htmlFor="sheet-musicxml-file" className="file-label">
          Upload MusicXML
        </label>
        <button className="btn btn-secondary" onClick={loadSample}>
          Load Sample
        </button>
        <span className="practice-status">{status}</span>
      </div>

      <div className="sheet-container">
        <div ref={containerRef} style={{ minHeight: 400 }} />
      </div>
    </div>
  )
}


