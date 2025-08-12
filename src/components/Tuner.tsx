import { useCallback, useEffect, useRef, useState } from 'react'
import { PitchDetector } from 'pitchy'

type PitchState = {
  frequencyHz: number | null
  cents: number | null
}

function computeCentsOffset(frequencyHz: number, targetHz: number): number {
  return 1200 * Math.log2(frequencyHz / targetHz)
}

export default function Tuner() {
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const detectorRef = useRef<ReturnType<typeof PitchDetector.forFloat32Array> | null>(null)
  const bufferRef = useRef<Float32Array | null>(null)
  const rafRef = useRef<number | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)

  const [isListening, setIsListening] = useState<boolean>(false)
  const [a4FrequencyHz, setA4FrequencyHz] = useState<number>(440)
  const [stabilizedPitch, setStabilizedPitch] = useState<PitchState>({ frequencyHz: null, cents: null })

  const clarityThreshold = 0.6

  const listen = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      })
      mediaStreamRef.current = mediaStream
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      audioContextRef.current = audioContext
      const source = audioContext.createMediaStreamSource(mediaStream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0
      source.connect(analyser)
      analyserRef.current = analyser
      const buffer = new Float32Array(analyser.fftSize)
      bufferRef.current = buffer
      const detector = PitchDetector.forFloat32Array(buffer.length)
      detectorRef.current = detector
      setIsListening(true)

      const tick = () => {
        const analyser = analyserRef.current!
        const buffer = bufferRef.current!
        const detector = detectorRef.current!
        analyser.getFloatTimeDomainData(buffer)
        const [freq, clarity] = detector.findPitch(buffer, audioContext.sampleRate)
        const hasPitch = Number.isFinite(freq) && clarity >= clarityThreshold

        // Stabilize pitch display (only update if pitch is stable for a moment)
        if (hasPitch) {
          setStabilizedPitch({ frequencyHz: freq, cents: null })
        } else {
          setStabilizedPitch({ frequencyHz: null, cents: null })
        }

        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (e) {
      console.error('Mic permission failed:', e)
      setIsListening(false)
    }
  }, [])

  const stopListening = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop())
      mediaStreamRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    setIsListening(false)
    setStabilizedPitch({ frequencyHz: null, cents: null })
  }, [])

  useEffect(() => {
    return () => {
      stopListening()
    }
  }, [stopListening])

  // Find closest note and calculate cents
  const getNoteInfo = (frequencyHz: number) => {
    const a4 = a4FrequencyHz
    const a4Midi = 69
    const midi = Math.round(12 * Math.log2(frequencyHz / a4) + a4Midi)
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    const noteName = noteNames[midi % 12]
    const octave = Math.floor(midi / 12) - 1
    const targetFreq = a4 * Math.pow(2, (midi - a4Midi) / 12)
    const cents = computeCentsOffset(frequencyHz, targetFreq)
    
    return { noteName, octave, cents, targetFreq }
  }

  const noteInfo = stabilizedPitch.frequencyHz ? getNoteInfo(stabilizedPitch.frequencyHz) : null

  return (
    <div className="component-container">
      <h2 className="component-title">Tuner</h2>
      
      <div style={{ display: 'flex', gap: '2rem', alignItems: 'center', marginBottom: '2rem' }}>
        <div className="input-group">
          <label>A4 Frequency (Hz)</label>
          <input
            type="number"
            value={a4FrequencyHz}
            onChange={(e) => setA4FrequencyHz(Number(e.target.value))}
            min={415}
            max={466}
            style={{ width: '120px' }}
          />
        </div>
        
        <button 
          className="btn" 
          onClick={isListening ? stopListening : listen}
        >
          {isListening ? 'Stop' : 'Start'}
        </button>
      </div>

      <div style={{ 
        textAlign: 'center', 
        padding: '3rem', 
        background: 'linear-gradient(135deg, rgba(102, 126, 234, 0.1) 0%, rgba(118, 75, 162, 0.1) 100%)', 
        borderRadius: '16px',
        border: '2px solid rgba(102, 126, 234, 0.3)',
        marginBottom: '2rem',
        backdropFilter: 'blur(10px)'
      }}>
        {stabilizedPitch.frequencyHz ? (
          <div>
            <div style={{ 
              fontSize: '4rem', 
              fontWeight: 'bold', 
              color: '#333',
              marginBottom: '1rem'
            }}>
              {noteInfo?.noteName}{noteInfo?.octave}
            </div>
            <div style={{ 
              fontSize: '2rem', 
              color: '#666',
              marginBottom: '1rem'
            }}>
              {stabilizedPitch.frequencyHz.toFixed(1)} Hz
            </div>
            <div style={{ 
              fontSize: '1.5rem',
              color: Math.abs(noteInfo?.cents || 0) < 10 ? '#2e8b57' : 
                     Math.abs(noteInfo?.cents || 0) < 30 ? '#d1a000' : '#b44',
              fontWeight: 'bold'
            }}>
              {noteInfo?.cents ? `${noteInfo.cents > 0 ? '+' : ''}${noteInfo.cents.toFixed(1)} cents` : '--'}
            </div>
          </div>
        ) : (
                  <div style={{ 
          fontSize: '2rem', 
          color: '#667eea',
          fontWeight: 'bold'
        }}>
          {isListening ? 'Listening...' : 'Click Start to begin'}
        </div>
        )}
      </div>

      {/* Visual cents meter */}
      {noteInfo && (
        <div style={{ 
          background: '#fff', 
          border: '1px solid #ddd', 
          borderRadius: '8px', 
          padding: '1rem',
          marginBottom: '1rem'
        }}>
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            marginBottom: '0.5rem',
            fontSize: '0.9rem',
            color: '#666'
          }}>
            <span>-50¢</span>
            <span>0¢</span>
            <span>+50¢</span>
          </div>
          <div style={{ 
            position: 'relative', 
            height: '20px', 
            background: 'linear-gradient(to right, #b44 0%, #d1a000 25%, #2e8b57 50%, #d1a000 75%, #b44 100%)',
            borderRadius: '10px',
            overflow: 'hidden'
          }}>
            <div style={{
              position: 'absolute',
              top: '0',
              left: `${Math.max(0, Math.min(100, 50 + (noteInfo.cents / 50) * 50))}%`,
              width: '2px',
              height: '100%',
              background: '#000',
              transform: 'translateX(-50%)',
              transition: 'left 0.1s ease'
            }} />
          </div>
        </div>
      )}

             <div style={{ 
         fontSize: '0.9rem', 
         color: '#667eea', 
         textAlign: 'center',
         fontStyle: 'italic'
       }}>
         {isListening && !stabilizedPitch.frequencyHz && 'Play a clear note to see tuning information'}
       </div>
    </div>
  )
}


