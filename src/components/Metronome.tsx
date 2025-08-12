import { useCallback, useEffect, useRef, useState, useMemo } from 'react'

export default function Metronome() {
  const [isRunning, setIsRunning] = useState(false)
  const [bpm, setBpm] = useState(64)
  const [accent, setAccent] = useState(true)
  
  const audioContextRef = useRef<AudioContext | null>(null)
  const schedulerIdRef = useRef<number | null>(null)
  const nextNoteTimeRef = useRef<number>(0)
  const beatNumberRef = useRef<number>(0)

  const secondsPerBeat = useMemo(() => 60 / bpm, [bpm])

  const createClickSound = useCallback((isAccent: boolean) => {
    const audioContext = audioContextRef.current!
    const oscillator = audioContext.createOscillator()
    const gainNode = audioContext.createGain()
    
    oscillator.connect(gainNode)
    gainNode.connect(audioContext.destination)
    
    // Create a more realistic click sound
    const frequency = isAccent ? 800 : 600
    const duration = 0.05
    
    oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime)
    oscillator.type = 'sine'
    
    // Add a noise transient for attack
    const noise = audioContext.createOscillator()
    const noiseGain = audioContext.createGain()
    noise.connect(noiseGain)
    noiseGain.connect(audioContext.destination)
    
    noise.frequency.setValueAtTime(2000, audioContext.currentTime)
    noise.type = 'sawtooth'
    
    // Envelope
    const now = audioContext.currentTime
    gainNode.gain.setValueAtTime(0, now)
    gainNode.gain.linearRampToValueAtTime(isAccent ? 0.3 : 0.2, now + 0.001)
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration)
    
    noiseGain.gain.setValueAtTime(0, now)
    noiseGain.gain.linearRampToValueAtTime(isAccent ? 0.1 : 0.05, now + 0.001)
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.02)
    
    oscillator.start(now)
    oscillator.stop(now + duration)
    noise.start(now)
    noise.stop(now + 0.02)
  }, [])

  const scheduleNote = useCallback((beatNumber: number) => {
    const isAccentBeat = accent && beatNumber % 4 === 0
    createClickSound(isAccentBeat)
  }, [createClickSound, accent])

  const scheduler = useCallback(() => {
    const audioContext = audioContextRef.current!
    const currentTime = audioContext.currentTime
    
          while (nextNoteTimeRef.current < currentTime + 0.1) {
        scheduleNote(beatNumberRef.current)
        beatNumberRef.current++
        nextNoteTimeRef.current += secondsPerBeat
      }
    
    schedulerIdRef.current = window.setTimeout(scheduler, 25) as unknown as number
  }, [scheduleNote, secondsPerBeat])

  const start = useCallback(async () => {
    if (isRunning) return
    
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      audioContextRef.current = audioContext
      
      setIsRunning(true)
      nextNoteTimeRef.current = audioContext.currentTime
      beatNumberRef.current = 0
      scheduler()
    } catch (error) {
      console.error('Failed to start metronome:', error)
    }
  }, [isRunning, scheduler])

  const stop = useCallback(() => {
    if (!isRunning) return
    
    if (schedulerIdRef.current) {
      clearTimeout(schedulerIdRef.current)
      schedulerIdRef.current = null
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    
    setIsRunning(false)
  }, [isRunning])

  useEffect(() => {
    return () => {
      stop()
    }
  }, [stop])

  return (
    <div className="component-container">
      <h2 className="component-title">Metronome</h2>
      
      <div style={{ display: 'flex', gap: '2rem', alignItems: 'center', marginBottom: '2rem' }}>
        <div className="input-group">
          <label>BPM</label>
          <input
            type="number"
            value={bpm}
            onChange={(e) => setBpm(Number(e.target.value))}
            min={20}
            max={240}
            style={{ width: '120px' }}
          />
        </div>
        
        <div className="input-group">
          <label>
            <input
              type="checkbox"
              checked={accent}
              onChange={(e) => setAccent(e.target.checked)}
              style={{ marginRight: '0.5rem' }}
            />
            Accent downbeat
          </label>
        </div>
        
        <button 
          className="btn" 
          onClick={isRunning ? stop : start}
        >
          {isRunning ? 'Stop' : 'Start'}
        </button>
      </div>

      <div style={{ 
        textAlign: 'center', 
        padding: '2rem', 
        background: '#f8f9fa', 
        borderRadius: '12px',
        border: '2px solid #e9ecef'
      }}>
        <div style={{ 
          fontSize: '3rem', 
          fontWeight: 'bold', 
          color: '#333',
          marginBottom: '1rem'
        }}>
          {bpm}
        </div>
        <div style={{ 
          fontSize: '1.2rem', 
          color: '#666'
        }}>
          Beats per minute
        </div>
        {isRunning && (
          <div style={{ 
            marginTop: '1rem',
            fontSize: '1rem',
            color: '#007acc',
            fontWeight: 'bold'
          }}>
            Playing...
          </div>
        )}
      </div>

      <div style={{ 
        marginTop: '1rem',
        fontSize: '0.9rem', 
        color: '#666', 
        textAlign: 'center',
        fontStyle: 'italic'
      }}>
        {accent ? 'Downbeats will be accented' : 'All beats will have the same volume'}
      </div>
    </div>
  )
}


