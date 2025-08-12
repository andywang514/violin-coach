import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { OpenSheetMusicDisplay, Cursor } from 'opensheetmusicdisplay'
import { PitchDetector } from 'pitchy'

type PitchState = {
  frequencyHz: number | null
  cents: number | null
}

function computeCentsOffset(frequencyHz: number, targetHz: number): number {
  return 1200 * Math.log2(frequencyHz / targetHz)
}

// Normalize cents to the nearest-octave window so UI doesn't show ±1200 jumps
function normalizeCents(cents: number): number {
  let n = cents
  // Keep within (-600, 600]
  while (n > 600) n -= 1200
  while (n <= -600) n += 1200
  return n
}

export default function KaraokePractice() {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)
  const cursorRef = useRef<Cursor | null>(null)

  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const detectorRef = useRef<ReturnType<typeof PitchDetector.forFloat32Array> | null>(null)
  const bufferRef = useRef<Float32Array | null>(null)
  const rafRef = useRef<number | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)

  const [status, setStatus] = useState<string>('Load a score to begin')
  const [isListening, setIsListening] = useState<boolean>(false)
  // Stabilized pitch state for display and logic (less frequent updates)
  const [stabilizedPitch, setStabilizedPitch] = useState<PitchState>({ frequencyHz: null, cents: null })
  const lastPitchUpdateRef = useRef<number>(0)
  const [targetInfo, setTargetInfo] = useState<{ midi: number | null; hz: number | null; name: string | null }>({
    midi: null,
    hz: null,
    name: null,
  })
  const [firstNoteMidi, setFirstNoteMidi] = useState<number | null>(null)
  const currentStepIndexRef = useRef<number>(0)
  const scoreMidiSequenceRef = useRef<MusicalElement[]>([])
  const [bpm, setBpm] = useState<number>(64)
  const [a4FrequencyHz] = useState<number>(440)
  const [isTransportRunning, setIsTransportRunning] = useState<boolean>(false)
  const [awaitingFirstCorrect, setAwaitingFirstCorrect] = useState<boolean>(true)
  const [metronomeEnabled, setMetronomeEnabled] = useState<boolean>(false)
  const [dynamicTempoEnabled, setDynamicTempoEnabled] = useState<boolean>(false)
  const [currentBpm, setCurrentBpm] = useState<number>(64)
  const [customStartIndex, setCustomStartIndex] = useState<number | null>(null)
  const [measureNumber, setMeasureNumber] = useState<number>(1)
  const [currentMeasure, setCurrentMeasure] = useState<number>(1)
  const measureBoundariesRef = useRef<number[]>([])
  // Keep the latest loaded MusicXML text so user can set it as default later
  const lastLoadedXmlRef = useRef<string | null>(null)
  // Input for loading a score from GitHub
  const [githubInput, setGithubInput] = useState<string>("")

  const schedulerIdRef = useRef<number | null>(null)
  const isTransportRunningRef = useRef<boolean>(false)
  const awaitingFirstCorrectRef = useRef<boolean>(true)
  const windowHadAccurateRef = useRef<boolean>(false)
  const windowHadAnyPitchRef = useRef<boolean>(false)
  const lastTargetMidiRef = useRef<number | null>(null)
  
  // Metronome refs
  const metronomeAudioContextRef = useRef<AudioContext | null>(null)
  const metronomeSchedulerIdRef = useRef<number | null>(null)
  const metronomeNextBeatTimeRef = useRef<number>(0)
  const metronomeBeatNumberRef = useRef<number>(0)
  
  // Dynamic tempo refs
  const consecutiveErrorsRef = useRef<number>(0)
  const lastErrorTimeRef = useRef<number>(0)
  
  type Mark = { x: number; y: number; kind: 'correct' | 'incorrect' | 'missed' }
  const [noteMarks, setNoteMarksState] = useState<Mark[]>([])
  const noteMarksRef = useRef<Mark[]>([])

  // Violin playable pitch range (approx). Used to ignore accompaniment/bass notes.
  const VIOLIN_MIN_MIDI = 55 // G3
  const VIOLIN_MAX_MIDI = 100 // E7
  
  // Keep ref in sync with state
  useEffect(() => {
    noteMarksRef.current = noteMarks
  }, [noteMarks])


  // threshold used to mark a note as correct during transport
  const correctDuringTransportCents = 20
  
  // Enhanced grading for complex music elements
  type MusicalElement = {
    midi: number
    accidental?: number // -1 for flat, 0 for natural, 1 for sharp
    dynamic?: string // 'p', 'mp', 'mf', 'f', etc.
    articulation?: string // 'accent', 'staccato', 'tenuto', etc.
    position?: number // violin position (1st, 3rd, etc.)
    string?: string // 'G', 'D', 'A', 'E'
  }

  const getGradingThreshold = useCallback((element: MusicalElement | null) => {
    if (!element) return correctDuringTransportCents
    
    let baseThreshold = correctDuringTransportCents
    const octave = Math.floor(element.midi / 12) - 1
    
    // Octave-based adjustments (existing logic)
    if (octave >= 6) baseThreshold = 35 // Higher notes get more tolerance
    else if (octave >= 5) baseThreshold = 30 // Upper register
    else if (octave <= 3) baseThreshold = 25 // Lower register
    
    // Accidental adjustments (sharps/flats are harder to play accurately)
    if (element.accidental !== undefined && element.accidental !== 0) {
      baseThreshold += 5 // More lenient for accidentals
    }
    
    // Position-based adjustments (higher positions are harder)
    if (element.position && element.position > 1) {
      baseThreshold += (element.position - 1) * 3 // +3 cents per position
    }
    
    // String-based adjustments (E string is harder for intonation)
    if (element.string === 'E') {
      baseThreshold += 3
    }
    
    // Articulation adjustments (some articulations affect intonation)
    if (element.articulation === 'staccato') {
      baseThreshold += 2 // Staccato notes are harder to tune
    }
    
    return Math.min(50, baseThreshold) // Cap at 50 cents
  }, [])
  const clarityThreshold = 0.6
  
  // Dynamic tempo adjustment based on performance
  const updateDynamicTempo = useCallback((wasAccurate: boolean) => {
    if (!dynamicTempoEnabled) return
    
    const now = performance.now()
    
    if (!wasAccurate) {
      consecutiveErrorsRef.current++
      lastErrorTimeRef.current = now
      
      // Slow down after 2 consecutive errors
      if (consecutiveErrorsRef.current >= 2) {
        const newBpm = Math.max(40, currentBpm - 8) // Slow down by 8 BPM, minimum 40
        setCurrentBpm(newBpm)
        console.log(`Slowing down to ${newBpm} BPM due to ${consecutiveErrorsRef.current} consecutive errors`)
      }
    } else {
      // Reset error count on success
      consecutiveErrorsRef.current = 0
      
      // Speed up gradually if no recent errors
      if (now - lastErrorTimeRef.current > 5000) { // 5 seconds without errors
        const newBpm = Math.min(bpm, currentBpm + 2) // Speed up by 2 BPM, max to original BPM
        if (newBpm !== currentBpm) {
          setCurrentBpm(newBpm)
          console.log(`Speeding up to ${newBpm} BPM due to good performance`)
        }
      }
    }
  }, [dynamicTempoEnabled, currentBpm, bpm])
  
  function sanitizeBpm(raw: number): number {
    if (!Number.isFinite(raw)) return 80
    return Math.min(240, Math.max(20, Math.floor(raw)))
  }
  const secondsPerBeat = useMemo(() => 60 / sanitizeBpm(currentBpm), [currentBpm])

  // Metronome functions
  const createMetronomeClick = useCallback((isAccent: boolean) => {
    console.log('Creating metronome click, accent:', isAccent)
    const audioContext = metronomeAudioContextRef.current!
    const oscillator = audioContext.createOscillator()
    const gainNode = audioContext.createGain()
    
    oscillator.connect(gainNode)
    gainNode.connect(audioContext.destination)
    
    // Create a much louder, more prominent click sound
    const frequency = isAccent ? 1200 : 1000
    const duration = 0.12
    
    oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime)
    oscillator.type = 'square' // More penetrating than sine
    
    // Add a noise transient for attack
    const noise = audioContext.createOscillator()
    const noiseGain = audioContext.createGain()
    noise.connect(noiseGain)
    noiseGain.connect(audioContext.destination)
    
    noise.frequency.setValueAtTime(4000, audioContext.currentTime)
    noise.type = 'sawtooth'
    
    // Envelope - much louder to penetrate violin sound
    const now = audioContext.currentTime
    gainNode.gain.setValueAtTime(0, now)
    gainNode.gain.linearRampToValueAtTime(isAccent ? 1.0 : 0.8, now + 0.001) // Much higher gain
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration)
    
    noiseGain.gain.setValueAtTime(0, now)
    noiseGain.gain.linearRampToValueAtTime(isAccent ? 0.4 : 0.3, now + 0.001) // Higher noise gain
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05) // Longer noise duration
    
    // Add a second oscillator for more volume
    const oscillator2 = audioContext.createOscillator()
    const gainNode2 = audioContext.createGain()
    oscillator2.connect(gainNode2)
    gainNode2.connect(audioContext.destination)
    
    oscillator2.frequency.setValueAtTime(frequency * 0.5, audioContext.currentTime) // Lower octave
    oscillator2.type = 'triangle'
    
    gainNode2.gain.setValueAtTime(0, now)
    gainNode2.gain.linearRampToValueAtTime(isAccent ? 0.6 : 0.4, now + 0.001)
    gainNode2.gain.exponentialRampToValueAtTime(0.001, now + duration)
    
    oscillator.start(now)
    oscillator.stop(now + duration)
    oscillator2.start(now)
    oscillator2.stop(now + duration)
    noise.start(now)
    noise.stop(now + 0.05)
    console.log('Metronome click created and started')
  }, [])

  const scheduleMetronomeBeat = useCallback((beatNumber: number) => {
    const isAccentBeat = beatNumber % 4 === 0
    console.log(`Metronome beat ${beatNumber} (accent: ${isAccentBeat})`)
    createMetronomeClick(isAccentBeat)
  }, [createMetronomeClick])

  const metronomeScheduler = useCallback(() => {
    const audioContext = metronomeAudioContextRef.current!
    const currentTime = audioContext.currentTime
    
    console.log('Metronome scheduler running, currentTime:', currentTime, 'nextBeat:', metronomeNextBeatTimeRef.current)
    
    while (metronomeNextBeatTimeRef.current < currentTime + 0.1) {
      scheduleMetronomeBeat(metronomeBeatNumberRef.current)
      metronomeBeatNumberRef.current++
      metronomeNextBeatTimeRef.current += secondsPerBeat
    }
    
    metronomeSchedulerIdRef.current = window.setTimeout(metronomeScheduler, 25) as unknown as number
  }, [scheduleMetronomeBeat, secondsPerBeat])

  const startMetronome = useCallback(async () => {
    console.log('startMetronome called, metronomeEnabled:', metronomeEnabled)
    if (!metronomeEnabled) {
      console.log('Metronome not enabled, returning')
      return
    }
    
    try {
      console.log('Creating audio context...')
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      metronomeAudioContextRef.current = audioContext
      
      // Resume audio context if suspended (required for user interaction)
      if (audioContext.state === 'suspended') {
        console.log('Resuming suspended audio context...')
        await audioContext.resume()
      }
      
      console.log('Audio context state:', audioContext.state)
      metronomeNextBeatTimeRef.current = audioContext.currentTime
      metronomeBeatNumberRef.current = 0
      console.log('Starting metronome scheduler...')
      metronomeScheduler()
    } catch (error) {
      console.error('Failed to start metronome:', error)
    }
  }, [metronomeEnabled, metronomeScheduler])

  const stopMetronome = useCallback(() => {
    if (metronomeSchedulerIdRef.current) {
      clearTimeout(metronomeSchedulerIdRef.current)
      metronomeSchedulerIdRef.current = null
    }
    
    if (metronomeAudioContextRef.current) {
      metronomeAudioContextRef.current.close()
      metronomeAudioContextRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    if (!osmdRef.current) {
      osmdRef.current = new OpenSheetMusicDisplay(containerRef.current, {
        autoResize: true,
        drawingParameters: 'compacttight',
        followCursor: true,
        renderSingleHorizontalStaffline: false,
        measureNumberInterval: 1,
        drawMeasureNumbers: true,
      })
    }
  }, [])

  // Cleanup metronome on unmount
  useEffect(() => {
    return () => {
      stopMetronome()
    }
  }, [stopMetronome])

  // Auto-load Seiffert piece on component mount
  useEffect(() => {
    if (osmdRef.current) {
      loadSample()
    }
  }, []) // Only run once on mount

  const loadSample = useCallback(async () => {
    if (!osmdRef.current) return
    
    // Reset all state when loading a new sheet
    setStabilizedPitch({ frequencyHz: null, cents: null })
    setTargetInfo({ midi: null, hz: null, name: null })
    setFirstNoteMidi(null)
    setAwaitingFirstCorrect(true)
    setNoteMarksState([])
    currentStepIndexRef.current = 0
    lastTargetMidiRef.current = null
    scoreMidiSequenceRef.current = []
    windowHadAccurateRef.current = false
    windowHadAnyPitchRef.current = false
    
    // Stop any running transport
    if (schedulerIdRef.current) {
      clearTimeout(schedulerIdRef.current)
      schedulerIdRef.current = null
    }
    setIsTransportRunning(false)
    isTransportRunningRef.current = false
    
    setStatus('Loading Seiffert Concertino...')
    // Prefer a user-saved default from localStorage
    const saved = localStorage.getItem('violinCoachDefaultXML')
    const candidates = [
      '/scores/Seiffert D Major Op24.musicxml',
      '/scores/complex-sample.musicxml',
      '/scores/gdae-exercise.musicxml',
      '/scores/twinkle-twinkle.musicxml',
      '/scores/mary-had-a-little-lamb.musicxml',
      '/scores/open-strings.musicxml',
      '/scores/sample.musicxml',
    ]
    let text = ''
    if (saved) {
      text = saved
    } else {
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
    }
    if (!text) throw new Error('No sample could be loaded')
    await osmdRef.current.load(text)
    await osmdRef.current.render()
    lastLoadedXmlRef.current = text
    const cursor = osmdRef.current.cursor
    cursor.show()
    cursorRef.current = cursor
    // Ensure cursor starts on a notehead, not between events
    const onNote = ensureCursorOnNote(cursor)
    setStatus(onNote ? 'Ready' : 'Ready (advanced to first note)')
    setAwaitingFirstCorrect(true)

    // Parse first target note from XML for robust start gating
    let midi = parseFirstNoteMidiFromXml(text)
    if (midi == null) {
      // Fallback: use the first graphical note at the cursor
      const notes = getNotesUnderCursor(cursor as any)
      const g = notes[0]
      midi = g ? midiFromGraphicalNote(g) : null
    }
    setFirstNoteMidi(midi)
    if (midi != null) {
      const hz = midiToFrequency(midi, a4FrequencyHz)
      setTargetInfo({ midi, hz, name: midiToName(midi) })
    } else {
      setTargetInfo((prev) => prev)
    }

            // Build sequence directly from MusicXML for accuracy with enhanced parsing
        try {
          const seq: MusicalElement[] = []
          const parser = new DOMParser()
          const doc = parser.parseFromString(text, 'application/xml')
          const noteEls = Array.from(doc.getElementsByTagName('note'))
          
          // Get key signature for proper accidental handling
          const keyEl = doc.getElementsByTagName('key')[0]
          const fifths = keyEl ? parseInt(keyEl.getElementsByTagName('fifths')[0]?.textContent || '0', 10) : 0
          
          for (const n of noteEls) {
            const rest = n.getElementsByTagName('rest')[0]
            if (rest) continue // Skip rests
            
            const pitchEl = n.getElementsByTagName('pitch')[0]
            if (!pitchEl) continue
            
            const step = pitchEl.getElementsByTagName('step')[0]?.textContent || 'C'
            const alterText = pitchEl.getElementsByTagName('alter')[0]?.textContent
            const alter = alterText ? parseInt(alterText, 10) : 0
            const octave = parseInt(pitchEl.getElementsByTagName('octave')[0]?.textContent || '4', 10)
            
            // Enhanced step to semitone mapping with proper accidental handling
            const stepToSemitone: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
            const base = stepToSemitone[step] ?? 0
            
            // Apply accidental (sharp/flat) from the note
            const semitone = base + alter
            const midi = (octave + 1) * 12 + semitone
            
            // Extract musical elements for enhanced grading
            const element: MusicalElement = { midi }
            
            // Add accidental information
            if (alter !== 0) {
              element.accidental = alter
            }
            
            // Extract dynamics
            const dynamicsEl = n.parentElement?.getElementsByTagName('dynamics')[0]
            if (dynamicsEl) {
              const dynamicTypes = ['p', 'mp', 'mf', 'f', 'pp', 'ff']
              for (const type of dynamicTypes) {
                if (dynamicsEl.getElementsByTagName(type)[0]) {
                  element.dynamic = type
                  break
                }
              }
            }
            
            // Extract articulations
            const articulationsEl = n.getElementsByTagName('articulations')[0]
            if (articulationsEl) {
              const articulationTypes = ['accent', 'staccato', 'tenuto', 'marcato']
              for (const type of articulationTypes) {
                if (articulationsEl.getElementsByTagName(type)[0]) {
                  element.articulation = type
                  break
                }
              }
            }
            
            // Determine violin string and position (simplified estimation)
            if (midi >= 55 && midi <= 66) element.string = 'G' // G3 to G4
            else if (midi >= 62 && midi <= 73) element.string = 'D' // D4 to D5
            else if (midi >= 69 && midi <= 80) element.string = 'A' // A4 to A5
            else if (midi >= 76 && midi <= 87) element.string = 'E' // E5 to E6
            
            // Estimate position based on octave and string
            if (octave >= 5) element.position = Math.max(1, Math.floor((octave - 4) / 2) + 1)
            
            // Validate MIDI note is in reasonable range
            if (midi >= 21 && midi <= 108) { // Piano range, but good for violin too
              seq.push(element)
            }
          }
          
          scoreMidiSequenceRef.current = seq
          currentStepIndexRef.current = 0
          lastTargetMidiRef.current = seq[0]?.midi ?? midi ?? null
          console.log('Built enhanced sequence from XML:', seq.map(m => midiToName(m.midi)))
          console.log('Key signature fifths:', fifths)
        } catch (e) {
          console.log('Enhanced sequence building error:', e)
        }
        
                          // Parse measure boundaries using the same sequence we built
        try {
          const parser = new DOMParser()
          const doc = parser.parseFromString(text, 'application/xml')
          const measureBoundaries: number[] = [0] // Start with 0
          let noteIndex = 0
          const measureEls = Array.from(doc.getElementsByTagName('measure'))
          
          console.log('Found', measureEls.length, 'measures in XML')
          
          for (const measureEl of measureEls) {
            const measureNotes = Array.from(measureEl.getElementsByTagName('note'))
            // Count only non-rest notes (same logic as sequence building)
            const noteCount = measureNotes.filter(note => !note.getElementsByTagName('rest')[0]).length
            if (noteCount > 0) {
              noteIndex += noteCount
              // Store the start index of the NEXT measure
              measureBoundaries.push(noteIndex)
            }
          }
          
          measureBoundariesRef.current = measureBoundaries
          console.log('Measure boundaries:', measureBoundaries)
        } catch (e) {
          console.log('Measure boundary parsing error:', e)
          // Fallback to estimation
          const seq = scoreMidiSequenceRef.current
          const notesPerMeasure = 5
          const estimatedBoundaries = [0]
          for (let i = notesPerMeasure; i < seq.length; i += notesPerMeasure) {
            estimatedBoundaries.push(i)
          }
          measureBoundariesRef.current = estimatedBoundaries
          console.log('Using estimated measure boundaries:', estimatedBoundaries)
        }
  }, [])

  // Convert various GitHub inputs into a raw content URL
  function toRawGithubUrl(input: string): string | null {
    const s = (input || '').trim()
    if (!s) return null
    if (s.startsWith('https://raw.githubusercontent.com/')) return s
    if (s.startsWith('https://github.com/')) {
      // https://github.com/owner/repo/blob/branch/path -> raw
      const parts = s.replace('https://github.com/', '').split('/')
      if (parts.length >= 5 && parts[2] === 'blob') {
        const [owner, repo, _blob, branch, ...path] = parts
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path.join('/')}`
      }
      return null
    }
    // owner/repo/path (assume main branch)
    const seg = s.split('/')
    if (seg.length >= 3) {
      const owner = seg[0]
      const repo = seg[1]
      const path = seg.slice(2).join('/')
      const branch = 'main'
      return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`
    }
    return null
  }

  const loadFromGithub = useCallback(async () => {
    if (!osmdRef.current) return
    const rawUrl = toRawGithubUrl(githubInput)
    if (!rawUrl) {
      setStatus('Enter a GitHub raw URL or owner/repo/path')
      return
    }
    try {
      setStatus('Loading from GitHub...')
      const res = await fetch(rawUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      if (!text.includes('<score-partwise') && !text.includes('<score-timewise')) {
        throw new Error('Not a MusicXML file')
      }
      await osmdRef.current.load(text)
      await osmdRef.current.render()
      lastLoadedXmlRef.current = text
      setStatus('GitHub score loaded')
      // Reset gating/target similarly to loadSample
      const cursor = osmdRef.current.cursor
      cursor.show()
      ensureCursorOnNote(cursor)
      const g = getNotesUnderCursor(cursor as any)[0]
      const m = g ? midiFromGraphicalNote(g) : null
      setFirstNoteMidi(m)
      if (m != null) setTargetInfo({ midi: m, hz: midiToFrequency(m, a4FrequencyHz), name: midiToName(m) })
      // Rebuild sequence from XML (minimal)
      try {
        const parser = new DOMParser()
        const doc = parser.parseFromString(text, 'application/xml')
        const noteEls = Array.from(doc.getElementsByTagName('note'))
        const seq: MusicalElement[] = []
        const stepToSemitone: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
        for (const n of noteEls) {
          if (n.getElementsByTagName('rest')[0]) continue
          const p = n.getElementsByTagName('pitch')[0]
          if (!p) continue
          const step = p.getElementsByTagName('step')[0]?.textContent || 'C'
          const alterTxt = p.getElementsByTagName('alter')[0]?.textContent
          const alter = alterTxt ? parseInt(alterTxt, 10) : 0
          const octave = parseInt(p.getElementsByTagName('octave')[0]?.textContent || '4', 10)
          const midi = (octave + 1) * 12 + (stepToSemitone[step] ?? 0) + alter
          if (midi >= 21 && midi <= 108) seq.push({ midi })
        }
        scoreMidiSequenceRef.current = seq
        currentStepIndexRef.current = 0
        lastTargetMidiRef.current = seq[0]?.midi ?? m ?? null
      } catch {}
    } catch (e) {
      setStatus(`Failed to load from GitHub: ${e instanceof Error ? e.message : 'error'}`)
    }
  }, [githubInput, a4FrequencyHz])



  const getCursorPitchHz = useCallback((): number | null => {
    const cursor = osmdRef.current?.cursor as any
    const notes = getNotesUnderCursor(cursor)
    const gNote = notes[0]
    if (!gNote) return null
    const midi = midiFromGraphicalNote(gNote)
    if (midi == null) return null
    const freq = a4FrequencyHz * Math.pow(2, (midi - 69) / 12)
    return freq
  }, [a4FrequencyHz])

  // Get current measure directly from OSMD cursor when available
  const getCurrentMeasure = useCallback((): number => {
    const cursor = osmdRef.current?.cursor
    const idx = (cursor as any)?.Iterator?.CurrentMeasureIndex
    if (typeof idx === 'number' && idx >= 0) {
      return idx + 1
    }
    return 1
  }, [])

  // Update current measure in real-time
  useEffect(() => {
    const updateCurrentMeasure = () => {
      const newMeasure = getCurrentMeasure()
      setCurrentMeasure(newMeasure)
    }

    // Update immediately
    updateCurrentMeasure()

    // Set up interval to update every 500ms
    const interval = setInterval(updateCurrentMeasure, 500)

    return () => clearInterval(interval)
  }, [getCurrentMeasure])

  // No longer used for gating; sequence-driven now. Kept for potential future features.

  function ensureCursorOnNote(cursor: Cursor): boolean {
    const anyCursor = cursor as any
    for (let guard = 0; guard < 16; guard++) {
      const notes = getNotesUnderCursor(anyCursor)
      if (notes.length > 0) return true
      if (anyCursor?.Iterator?.endReached) return false
      cursor.next()
    }
    return false
  }

  function getNotesUnderCursor(cursorAny: any): any[] {
    try {
      if (!cursorAny) return []
      if (typeof cursorAny.NotesUnderCursor === 'function') {
        return cursorAny.NotesUnderCursor() ?? []
      }
      return (cursorAny.NotesUnderCursor as any[]) ?? []
    } catch {
      return []
    }
  }

  function selectPrimaryNoteFromArray(notes: any[]): any | null {
    if (!notes || notes.length === 0) return null
    // Consider only musically valid MIDI range; ignore placeholders/clefs/etc.
    const candidates: Array<{ n: any; midi: number }> = []
    for (const n of notes) {
      const m = midiFromGraphicalNote(n)
      if (m != null && m >= VIOLIN_MIN_MIDI && m <= VIOLIN_MAX_MIDI) {
        candidates.push({ n, midi: m })
      }
    }
    if (candidates.length === 0) return null
    // Deterministic choice: HIGHEST MIDI at that time slice (prefer top note visually)
    candidates.sort((a, b) => b.midi - a.midi)
    return candidates[0].n
  }

  // Prefer a note closest to a given MIDI (e.g., previously selected target),
  // falling back to the highest pitch when no preference is provided.
  function selectPreferredNote(notes: any[], preferredMidi?: number | null): any | null {
    if (!notes || notes.length === 0) return null
    const candidates: Array<{ n: any; midi: number }> = []
    for (const n of notes) {
      const m = midiFromGraphicalNote(n)
      if (m != null && m >= VIOLIN_MIN_MIDI && m <= VIOLIN_MAX_MIDI) {
        candidates.push({ n, midi: m })
      }
    }
    if (candidates.length === 0) return null
    if (preferredMidi != null) {
      candidates.sort((a, b) => Math.abs(a.midi - preferredMidi) - Math.abs(b.midi - preferredMidi))
      return candidates[0].n
    }
    candidates.sort((a, b) => b.midi - a.midi)
    return candidates[0].n
  }

  function midiFromGraphicalNote(gn: any): number | null {
    const note = gn?.sourceNote || gn
    if (!note) return null
    
    // Try halfTone first (most direct) - check both on note and sourceNote
    if (typeof note.halfTone === 'number') {
      return note.halfTone as number
    }
    if (typeof gn?.halfTone === 'number') {
      return gn.halfTone as number
    }
    
    // Try pitch object
    const p = note.pitch || gn?.pitch
    if (p) {
      // If pitch already provides halfTone, prefer it
      if (typeof p.halfTone === 'number') {
        return p.halfTone as number
      }
      const step = typeof p.FundamentalNote === 'number'
        ? (p.FundamentalNote as number)
        : (typeof p.fundamentalNote === 'number' ? (p.fundamentalNote as number) : null)
      const octave = typeof p.Octave === 'number'
        ? (p.Octave as number)
        : (typeof p.octave === 'number' ? (p.octave as number) : null)
      if (step != null && octave != null) {
        const stepToSemitone = [0, 2, 4, 5, 7, 9, 11] // C D E F G A B
        let semitone = stepToSemitone[step] ?? 0
        const accidentalHalf = typeof p.AccidentalHalfTone === 'number'
          ? (p.AccidentalHalfTone as number)
          : (typeof p.accidentalHalfTone === 'number'
              ? (p.accidentalHalfTone as number)
              : (typeof p.accidental === 'number' ? (p.accidental as number) : 0))
        semitone += accidentalHalf
        const midi = (octave + 1) * 12 + semitone
        return midi
      }
    }
    
    return null
  }

  function midiToName(midi: number): string {
    const sharpNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    const noteIndex = (midi + 1200) % 12
    const octave = Math.floor(midi / 12) - 1
    
    // Use sharps for most cases, but could be enhanced to use key signature
    const name = sharpNames[noteIndex]
    return `${name}${octave}`
  }

  function midiToFrequency(midi: number, a4: number): number {
    return a4 * Math.pow(2, (midi - 69) / 12)
  }

  // Extract a numeric timestamp from OSMD's Fraction-like object
  function getTimestampReal(ts: any): number | null {
    if (!ts) return null
    if (typeof ts.RealValue === 'number') return ts.RealValue as number
    const num = (ts?.Numerator as number) ?? (ts?.numerator as number)
    const den = (ts?.Denominator as number) ?? (ts?.denominator as number)
    if (typeof num === 'number' && typeof den === 'number' && den !== 0) {
      return num / den
    }
    return null
  }

  // Read the first timestamp in a measure that actually contains notes
  function getFirstNoteTimestampForMeasure(osmd: any, measureNumber: number): number | null {
    const measures: any[] | undefined = osmd?.Sheet?.SourceMeasures
    if (!Array.isArray(measures)) return null
    const measure = measures[measureNumber - 1]
    if (!measure) return null
    const vsecs: any[] = measure.VerticalStaffEntryContainers || []
    for (const vc of vsecs) {
      const ts = getTimestampReal(vc?.Timestamp)
      // StaffEntries contain noteheads for that vertical slice
      const staffEntries: any[] = vc?.StaffEntries || []
      const hasNotes = staffEntries.some((se: any) => Array.isArray(se?.Notes) && se.Notes.length > 0)
      if (hasNotes && typeof ts === 'number') return ts
    }
    return null
  }

  function parseFirstNoteMidiFromXml(xml: string): number | null {
    try {
      const parser = new DOMParser()
      const doc = parser.parseFromString(xml, 'application/xml')
      const noteEls = Array.from(doc.getElementsByTagName('note'))
      for (const n of noteEls) {
        const rest = n.getElementsByTagName('rest')[0]
        if (rest) continue
        const pitchEl = n.getElementsByTagName('pitch')[0]
        if (!pitchEl) continue
        const step = pitchEl.getElementsByTagName('step')[0]?.textContent || 'C'
        const alterText = pitchEl.getElementsByTagName('alter')[0]?.textContent
        const alter = alterText ? parseInt(alterText, 10) : 0
        const octave = parseInt(pitchEl.getElementsByTagName('octave')[0]?.textContent || '4', 10)
        const stepToSemitone: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
        const base = stepToSemitone[step] ?? 0
        const semitone = base + alter
        return (octave + 1) * 12 + semitone
      }
    } catch {
      // ignore
    }
    return null
  }

  const stopListening = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop())
      mediaStreamRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
    analyserRef.current = null
    detectorRef.current = null
    bufferRef.current = null
    setIsListening(false)
    setStabilizedPitch({ frequencyHz: null, cents: null })
    
    // Stop metronome when stopping listening
    stopMetronome()
  }, [stopMetronome])

  const stopTransport = useCallback(() => {
    if (schedulerIdRef.current) {
      clearTimeout(schedulerIdRef.current)
      schedulerIdRef.current = null
    }
    
    // Don't stop metronome - let it continue running
    // stopMetronome()
    
    setIsTransportRunning(false)
    isTransportRunningRef.current = false
  }, [])

  const startTransport = useCallback(() => {
    if (isTransportRunning) return
    const cursor = osmdRef.current?.cursor
    if (!cursor) return
    setIsTransportRunning(true)
    isTransportRunningRef.current = true
    
    // Reset dynamic tempo to original BPM when starting
    if (dynamicTempoEnabled) {
      setCurrentBpm(bpm)
      consecutiveErrorsRef.current = 0
      lastErrorTimeRef.current = 0
    }
    
    // Do NOT reset here; start exactly where the user positioned the cursor
    cursor.show()
    ensureCursorOnNote(cursor)
    console.log('Transport starting from current cursor position at measure', (cursor as any)?.Iterator?.CurrentMeasureIndex + 1)
    const step = () => {
      const seq = scoreMidiSequenceRef.current
      const anyCursor = cursor as any
      if (anyCursor?.Iterator?.endReached) {
        stopTransport()
        return
      }
      try {
        const container = wrapperRef.current
        const cursorEl = (osmdRef.current as any)?.cursor?.cursorElement as HTMLElement | undefined
        if (container && cursorEl) {
          const cr = cursorEl.getBoundingClientRect()
          const pr = container.getBoundingClientRect()
          const x = cr.left - pr.left + cr.width / 2
          const y = cr.bottom - pr.top + 8
          const wasAccurate = windowHadAccurateRef.current
          const kind: 'correct' | 'incorrect' | 'missed' = wasAccurate
            ? 'correct'
            : windowHadAnyPitchRef.current
              ? 'incorrect'
              : 'missed'
          const next = [...(noteMarksRef.current || []), { x, y, kind }]
          noteMarksRef.current = next
          setNoteMarksState(next)
          
          // Update dynamic tempo based on performance
          updateDynamicTempo(wasAccurate)
          
          // Log enhanced grading info
          if (wasAccurate) {
            const currentElement = seq[currentStepIndexRef.current ?? 0]
            const threshold = getGradingThreshold(currentElement)
            console.log(`✓ Correct: ${midiToName(currentElement?.midi ?? 0)} (threshold: ±${threshold} cents)`)
          } else if (windowHadAnyPitchRef.current) {
            const currentElement = seq[currentStepIndexRef.current ?? 0]
            const threshold = getGradingThreshold(currentElement)
            console.log(`✗ Incorrect: ${midiToName(currentElement?.midi ?? 0)} (threshold: ±${threshold} cents)`)
          }
        }
      } catch {}
      windowHadAccurateRef.current = false
      windowHadAnyPitchRef.current = false

      // Advance through our sequence explicitly
      if (seq.length > 0) {
        const nextIdx = (currentStepIndexRef.current ?? 0) + 1
        if (nextIdx < seq.length) {
          currentStepIndexRef.current = nextIdx
          const element = seq[nextIdx]
          if (element != null) {
            lastTargetMidiRef.current = element.midi
            setTargetInfo({ midi: element.midi, hz: midiToFrequency(element.midi, a4FrequencyHz), name: midiToName(element.midi) })
          }
          // Move cursor to match the sequence position
          cursor.next()
          ensureCursorOnNote(cursor)
        } else {
          // Reached the end of the sequence - stop transport
          stopTransport()
          return
        }
      }
      // schedule next step precisely using setTimeout based on current bpm
      schedulerIdRef.current = window.setTimeout(step, secondsPerBeat * 1000) as unknown as number
    }
    schedulerIdRef.current = window.setTimeout(step, secondsPerBeat * 1000) as unknown as number
  }, [isTransportRunning, secondsPerBeat, stopTransport])

  const updateCursorVisual = useCallback((cents: number | null) => {
    const cursor = (osmdRef.current as any)?.cursor
    const el: HTMLElement | null | undefined = cursor?.cursorElement
    if (!el) return
    const magnitude = cents == null ? null : Math.abs(cents)
    let color = '#888'
    if (magnitude != null) {
      if (magnitude < 10) color = '#2e8b57'
      else if (magnitude < 30) color = '#d1a000'
      else color = '#b44'
    }
    el.style.backgroundColor = color
    el.style.opacity = '0.6'
    el.style.width = '3px'
  }, [])

  const listen = useCallback(async () => {
    console.log('🎵 LISTEN FUNCTION CALLED - Starting audio capture')
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

      // Reset grading state when starting to listen
      windowHadAccurateRef.current = false
      windowHadAnyPitchRef.current = false
      awaitingFirstCorrectRef.current = true

      // Cursor should already be positioned by jumpToMeasure, just ensure it's on a note
      const cursor = osmdRef.current?.cursor
      console.log(`🎯 Cursor check: customStartIndex = ${customStartIndex}, cursor exists = ${!!cursor}`)
      if (cursor) {
        if (customStartIndex !== null && customStartIndex > 0) {
          // Cursor should already be positioned correctly by jumpToMeasure
          console.log(`Cursor should already be at measure ${measureNumber} - target: ${midiToName(scoreMidiSequenceRef.current[customStartIndex]?.midi)}`)
          
          ensureCursorOnNote(cursor)
          cursor.show()
          
          // Verify cursor position
      const notes = getNotesUnderCursor(cursor as any)
      const currentNote = selectPrimaryNoteFromArray(notes)
          const currentMidi = currentNote ? midiFromGraphicalNote(currentNote) : null
          const expectedMidi = scoreMidiSequenceRef.current[customStartIndex]?.midi
          
          console.log(`Cursor at: ${currentMidi ? midiToName(currentMidi) : 'null'} (target: ${expectedMidi ? midiToName(expectedMidi) : 'null'})`)
          
          if (currentMidi === expectedMidi) {
            console.log(`✅ SUCCESS: Cursor is on the correct target note!`)
            setStatus(`✅ Cursor positioned correctly at measure ${measureNumber}`)
          } else {
            console.log(`⚠️ Cursor is not on exact target note`)
            setStatus(`⚠️ Cursor near measure ${measureNumber} - target note: ${expectedMidi ? midiToName(expectedMidi) : 'unknown'}`)
          }
          
          console.log(`🎯 IMPORTANT: Target note is ${expectedMidi ? midiToName(expectedMidi) : 'unknown'} - play this note to start!`)
        } else {
          ensureCursorOnNote(cursor)
        }
      }
      
      // Determine target for UI and gating without overriding an existing target from Jump
      const currentCursor = osmdRef.current?.cursor
      let targetMidi: number | null = targetInfo.midi ?? null
      if (targetMidi == null && currentCursor) {
        const notes = getNotesUnderCursor(currentCursor as any)
        const currentNote = selectPrimaryNoteFromArray(notes)
        const currentMidi = currentNote ? midiFromGraphicalNote(currentNote) : null
        if (currentMidi !== null) {
          targetMidi = currentMidi
          console.log(`Listen: Using cursor note ${midiToName(currentMidi)} as target`)
        }
      }
      if (targetMidi == null) targetMidi = firstNoteMidi
      
      if (targetMidi != null) {
        const hz = midiToFrequency(targetMidi, a4FrequencyHz)
        // Only update UI target if it was previously unset, to avoid visual jumps
        if (targetInfo.midi == null) {
          setTargetInfo({ midi: targetMidi, hz, name: midiToName(targetMidi) })
        }
        lastTargetMidiRef.current = targetMidi
      }
      
      // Start metronome immediately if enabled
      if (metronomeEnabled) {
        console.log('Starting metronome immediately...')
        startMetronome()
      }

      const tick = () => {
        const analyser = analyserRef.current!
        const buffer = bufferRef.current!
        const detector = detectorRef.current!
        analyser.getFloatTimeDomainData(buffer)
        const [freq, clarity] = detector.findPitch(buffer, audioContext.sampleRate)
        // Filter for violin frequency range (G3 ~196Hz to E7 ~2637Hz)
        const isInViolinRange = freq >= 180 && freq <= 2800
        const hasPitch = Number.isFinite(freq) && clarity >= clarityThreshold && isInViolinRange
        // Determine grading target
        // - If transport is running, use sequence-driven target
        // - If transport is idle, use the current cursor note (unified with visual cursor)
        const seq = scoreMidiSequenceRef.current
        const midiSeqTarget = seq[currentStepIndexRef.current ?? 0] ?? null
        let effectiveMidi: number | null = null
        if (isTransportRunningRef.current) {
          effectiveMidi = midiSeqTarget?.midi ?? lastTargetMidiRef.current
        } else {
          const idleCursor = osmdRef.current?.cursor
          if (idleCursor) {
            const idleNotes = getNotesUnderCursor(idleCursor as any)
            const idleNote = selectPreferredNote(idleNotes, targetInfo.midi ?? lastTargetMidiRef.current)
            effectiveMidi = idleNote ? midiFromGraphicalNote(idleNote) : null
          }
          if (effectiveMidi == null) effectiveMidi = lastTargetMidiRef.current
        }
        const gatingTargetHz = effectiveMidi != null ? midiToFrequency(effectiveMidi, a4FrequencyHz) : null
        // Raw cents for grading; UI uses a normalized version to avoid octave-sized numbers
        const rawCents = hasPitch && gatingTargetHz ? computeCentsOffset(freq, gatingTargetHz) : null
        
        // Update stabilized pitch display (throttled to 100ms intervals)
        const currentTime = performance.now()
        if (currentTime - lastPitchUpdateRef.current > 100) {
          if (hasPitch) {
            setStabilizedPitch({ frequencyHz: freq, cents: rawCents == null ? null : normalizeCents(rawCents) })
          } else {
            setStabilizedPitch({ frequencyHz: null, cents: null })
          }
          lastPitchUpdateRef.current = currentTime
        }
        
        // Cursor colorization should reflect perceived (normalized) deviation
        updateCursorVisual(rawCents == null ? null : normalizeCents(rawCents))
        if (isTransportRunningRef.current) {
          if (hasPitch) {
            windowHadAnyPitchRef.current = true
            const threshold = getGradingThreshold(midiSeqTarget)
            if (rawCents != null && Math.abs(rawCents) <= threshold) {
              windowHadAccurateRef.current = true
            }
          }
        }

        // Do not override target while idle; target is set explicitly by jump/listen

        // Keep the visual Target in sync with the effective MIDI we are grading against when idle
        if (!isTransportRunningRef.current && effectiveMidi != null && effectiveMidi >= VIOLIN_MIN_MIDI && effectiveMidi <= VIOLIN_MAX_MIDI) {
          const eff = effectiveMidi
          setTargetInfo(prev => {
            if (prev.midi === eff && prev.hz) return prev
            const hz = midiToFrequency(eff, a4FrequencyHz)
            return { midi: eff, hz, name: midiToName(eff) }
          })
        }

        // Require a brief stability before starting transport
        const stableForMsRef = (listen as any)._stableForMsRef || ((listen as any)._stableForMsRef = { t: 0 })
        const stableTime = performance.now()
        const threshold = getGradingThreshold(midiSeqTarget)
        const isAccurate = awaitingFirstCorrectRef.current && rawCents != null && Math.abs(rawCents) <= threshold && !!gatingTargetHz
        if (isAccurate) {
          if (stableForMsRef.t === 0) stableForMsRef.t = stableTime
          if (stableTime - stableForMsRef.t > 250) {
            setAwaitingFirstCorrect(false)
            awaitingFirstCorrectRef.current = false
            // Switch gating to cursor-driven by clearing first-note target
            setFirstNoteMidi(null)
            // Ensure cursor is on first graphical note at start
            const cursor = osmdRef.current?.cursor
            if (cursor) ensureCursorOnNote(cursor)
            startTransport()
          }
        } else {
          stableForMsRef.t = 0
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Mic permission failed')
      stopListening()
    }
  }, [awaitingFirstCorrect, getCursorPitchHz, startTransport, stopListening, updateCursorVisual, firstNoteMidi, a4FrequencyHz])



  // Jump to specific measure number using OSMD's measure information
  const jumpToMeasure = useCallback(() => {
    if (!osmdRef.current) return
    
    console.log(`Jumping to measure ${measureNumber} using OSMD...`)
    
    const osmd = osmdRef.current
    const cursor = osmd.cursor
    
    if (cursor) {
      // Determine the exact first timestamp of the target measure that has notes
      const firstTs = getFirstNoteTimestampForMeasure(osmd as any, measureNumber)
      cursor.reset()
      let guard = 0
      while (guard++ < 4096) {
        const curMeasure = (cursor.Iterator?.CurrentMeasureIndex || 0) + 1
        const curTs = getTimestampReal((cursor as any)?.Iterator?.CurrentTimeStamp)
        if (curMeasure > measureNumber) break
        if (curMeasure === measureNumber) {
          if (firstTs == null || (typeof curTs === 'number' && curTs >= firstTs)) break
        }
        cursor.next()
      }
      // Ensure we are on a note within the same measure
      {
        let tries = 0
        while (tries++ < 256) {
          const curMeasure = (cursor.Iterator?.CurrentMeasureIndex || 0) + 1
          if (curMeasure !== measureNumber) break
          const notes = getNotesUnderCursor(cursor as any)
          if (notes?.length) break
          cursor.next()
        }
      }
      cursor.show()
      
      // Debug: show position after scan
      const debugMeasure = cursor.Iterator?.CurrentMeasureIndex || 0
      const debugNotes = getNotesUnderCursor(cursor as any)
      const debugNote = selectPrimaryNoteFromArray(debugNotes)
      const debugMidi = debugNote ? midiFromGraphicalNote(debugNote) : null
      console.log(`Final position: measure ${debugMeasure + 1}, note ${debugMidi ? midiToName(debugMidi) : 'null'}`)

      // Get the note at the target position (post-scan)
      const notes = getNotesUnderCursor(cursor as any)
      const currentNote = selectPrimaryNoteFromArray(notes)
      const currentMidi = currentNote ? midiFromGraphicalNote(currentNote) : null
      const finalMeasure = cursor.Iterator?.CurrentMeasureIndex || 0
      
      console.log(`Cursor positioned at: measure ${finalMeasure + 1}, note ${currentMidi ? midiToName(currentMidi) : 'null'}`)
      // Sync UI state with actual OSMD position immediately
      setCurrentMeasure(finalMeasure + 1)
      setMeasureNumber(finalMeasure + 1)
      console.log(`Notes under cursor:`, notes.length, notes.map(n => {
        const midi = midiFromGraphicalNote(n)
        return midi !== null ? midiToName(midi) : 'null'
      }))
      
      // Debug: Show raw note data
      if (notes.length > 0) {
        console.log(`Raw note data:`, {
          sourceNote: currentNote?.sourceNote,
          halfTone: currentNote?.sourceNote?.halfTone,
          pitch: currentNote?.sourceNote?.pitch,
          fundamentalNote: currentNote?.sourceNote?.pitch?.FundamentalNote,
          octave: currentNote?.sourceNote?.pitch?.Octave,
          accidental: currentNote?.sourceNote?.pitch?.AccidentalHalfTone
        })
      }
      
      // No longer using parsed sequence - rely only on OSMD's cursor and note detection
      
      // Set the target info
      if (currentMidi !== null) {
        const hz = midiToFrequency(currentMidi, a4FrequencyHz)
        const targetName = midiToName(currentMidi)
        
        console.log(`Setting target: midi=${currentMidi}, name=${targetName}, hz=${hz}`)
        setTargetInfo({ midi: currentMidi, hz, name: targetName })
        
        // Don't set customStartIndex - let the listen function use the actual detected note
        // setCustomStartIndex(steps)
        
        setStatus(`Starting point set to measure ${finalMeasure + 1}, note ${targetName}`)
        
        // Verify this is actually the first note of the measure
        console.log(`Target set to: measure ${finalMeasure + 1}, first note: ${targetName}`)
      } else {
        setStatus(`Could not determine note at measure ${finalMeasure + 1}`)
      }
    } else {
      setStatus('No cursor available')
    }
  }, [measureNumber, a4FrequencyHz])

  // Reset custom start point
  const resetStartPoint = useCallback(() => {
    setCustomStartIndex(null)
    setStatus('Starting point reset to beginning')
    
    // Reset cursor to first note
    const cursor = osmdRef.current?.cursor
    if (cursor) {
      cursor.reset()
      ensureCursorOnNote(cursor)
      
      // Update target info to first note
      const seq = scoreMidiSequenceRef.current
      if (seq.length > 0) {
        const firstElement = seq[0]
        const hz = midiToFrequency(firstElement.midi, a4FrequencyHz)
        setTargetInfo({ midi: firstElement.midi, hz, name: midiToName(firstElement.midi) })
      }
    }
  }, [a4FrequencyHz])





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
        const cursor = osmdRef.current!.cursor
        cursor.show()
        cursorRef.current = cursor
        const onNote = ensureCursorOnNote(cursor)
        setStatus(onNote ? 'Ready' : 'Ready (advanced to first note)')
        setAwaitingFirstCorrect(true)
        
        // Parse first target note from XML
        let midi = parseFirstNoteMidiFromXml(text)
        if (midi == null) {
          const notes = getNotesUnderCursor(cursor as any)
          const g = notes[0]
          midi = g ? midiFromGraphicalNote(g) : null
        }
        setFirstNoteMidi(midi)
        if (midi != null) {
          const hz = midiToFrequency(midi, a4FrequencyHz)
          setTargetInfo({ midi, hz, name: midiToName(midi) })
        }
        
        // Build sequence from XML
        try {
          const seq: MusicalElement[] = []
          const parser = new DOMParser()
          const doc = parser.parseFromString(text, 'application/xml')
          const noteEls = Array.from(doc.getElementsByTagName('note'))
          
          for (const n of noteEls) {
            const rest = n.getElementsByTagName('rest')[0]
            if (rest) continue
            
            const pitchEl = n.getElementsByTagName('pitch')[0]
            if (!pitchEl) continue
            
            const step = pitchEl.getElementsByTagName('step')[0]?.textContent || 'C'
            const alterText = pitchEl.getElementsByTagName('alter')[0]?.textContent
            const alter = alterText ? parseInt(alterText, 10) : 0
            const octave = parseInt(pitchEl.getElementsByTagName('octave')[0]?.textContent || '4', 10)
            
            const stepToSemitone: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
            const base = stepToSemitone[step] ?? 0
            const semitone = base + alter
            const midi = (octave + 1) * 12 + semitone
            
            seq.push({ midi })
          }
          
          scoreMidiSequenceRef.current = seq
          currentStepIndexRef.current = 0
          lastTargetMidiRef.current = seq[0]?.midi ?? midi ?? null
          console.log('Built sequence from custom XML:', seq.map(m => midiToName(m.midi)))
        } catch (e) {
          console.log('Sequence building error:', e)
        }
      } catch (error) {
        setStatus('Error loading file')
        console.error(error)
      }
    }
    reader.readAsText(file)
  }, [a4FrequencyHz])

  return (
    <div className="practice-container">
      <div className="practice-header">
        <h2 className="component-title">Practice Mode</h2>
        <div className="practice-controls">
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '2rem',
            flexWrap: 'nowrap'
          }}>
            {/* BPM with inline label */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ 
                color: '#333', 
                fontSize: '0.9rem', 
                fontWeight: '600',
                whiteSpace: 'nowrap'
              }}>
                BPM:
              </span>
              <input 
                type="number" 
                value={bpm} 
                onChange={(e) => {
                  const newBpm = Number(e.target.value)
                  setBpm(newBpm)
                  if (dynamicTempoEnabled) {
                    setCurrentBpm(newBpm)
                  }
                }} 
                min={20} 
                max={240} 
                style={{ 
                  width: '60px', 
                  height: '32px',
                  border: '1px solid #ccc',
                  borderRadius: '4px',
                  padding: '0 8px',
                  fontSize: '0.9rem'
                }}
              />
              {dynamicTempoEnabled && (
                <span style={{ 
                  color: '#667eea', 
                  fontSize: '0.85rem',
                  fontWeight: 'bold',
                  whiteSpace: 'nowrap'
                }}>
                  (Current: {currentBpm})
                </span>
              )}
            </div>
            
            {/* Toggle controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
              <div className="metronome-toggle" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  id="metronome-toggle"
                  checked={metronomeEnabled}
                  onChange={(e) => setMetronomeEnabled(e.target.checked)}
                />
                <label htmlFor="metronome-toggle">Metronome</label>
              </div>
              <div className="metronome-toggle" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  id="dynamic-tempo-toggle"
                  checked={dynamicTempoEnabled}
                  onChange={(e) => setDynamicTempoEnabled(e.target.checked)}
                />
                <label htmlFor="dynamic-tempo-toggle">Dynamic Tempo</label>
              </div>
            </div>
            
            {/* Action button */}
            <button 
              className="btn" 
              onClick={isListening ? stopListening : listen} 
              disabled={!osmdRef.current}
              style={{ 
                minWidth: '140px',
                height: '36px',
                fontSize: '0.9rem',
                fontWeight: '600',
                marginLeft: 'auto'
              }}
            >
              {isListening ? 'Stop Listening' : 'Start Listening'}
            </button>
          </div>
        </div>
      </div>

      <div className="file-upload">
        <input
          type="file"
          id="musicxml-file"
          accept=".xml,.musicxml"
          className="file-input"
          onChange={handleFileUpload}
        />
        <label htmlFor="musicxml-file" className="file-label">
          Upload MusicXML
        </label>
        <button className="btn btn-secondary" onClick={loadSample} disabled={isListening}>
          Load Default
        </button>
        <input
          type="text"
          placeholder="owner/repo/path.xml or GitHub URL"
          value={githubInput}
          onChange={(e) => setGithubInput(e.target.value)}
          style={{
            width: '320px',
            height: '32px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '0 8px',
            fontSize: '0.9rem'
          }}
        />
        <button className="btn" onClick={loadFromGithub} disabled={isListening}>
          Load from GitHub
        </button>
        <button
          className="btn"
          onClick={() => {
            if (lastLoadedXmlRef.current) {
              localStorage.setItem('violinCoachDefaultXML', lastLoadedXmlRef.current)
              setStatus('Default score saved')
            } else {
              setStatus('No score loaded to save')
            }
          }}
          disabled={isListening}
        >
          Set as Default
        </button>
        <span className="practice-status">{status}</span>
      </div>

      {/* Click-to-start controls */}
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        gap: '1rem',
        marginTop: '1rem',
        padding: '1rem',
        backgroundColor: 'rgba(102, 126, 234, 0.1)',
        borderRadius: '8px',
        border: '1px solid rgba(102, 126, 234, 0.3)'
      }}>
        <span style={{ 
          color: '#333', 
          fontSize: '0.9rem', 
          fontWeight: '600'
        }}>
          Starting Point:
        </span>
        

        
        {customStartIndex !== null && (
          <button
            onClick={resetStartPoint}
            disabled={isTransportRunning || isListening}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#666',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.9rem',
              fontWeight: 'bold',
              cursor: isTransportRunning || isListening ? 'not-allowed' : 'pointer',
              opacity: isTransportRunning || isListening ? 0.6 : 1,
              transition: 'all 0.2s ease'
            }}
          >
            Reset to Start
          </button>
        )}
        
        {customStartIndex !== null && (
          <span style={{ 
            color: '#667eea', 
            fontSize: '0.9rem',
            fontWeight: 'bold'
          }}>
            Starting at note {customStartIndex + 1}
          </span>
        )}
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' }}>
          <span style={{ color: '#333', fontSize: '0.9rem' }}>Jump to Measure:</span>
          <input
            type="number"
            value={measureNumber}
            onChange={(e) => setMeasureNumber(Math.max(1, parseInt(e.target.value) || 1))}
            min={1}
            max={Math.max(1, measureBoundariesRef.current.length - 1)}
            style={{
              width: '60px',
              height: '32px',
              border: '1px solid #ccc',
              borderRadius: '4px',
              padding: '0 8px',
              fontSize: '0.9rem',
              textAlign: 'center'
            }}
          />
          <button
            onClick={jumpToMeasure}
            disabled={isTransportRunning || isListening}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#667eea',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.9rem',
              fontWeight: 'bold',
              cursor: isTransportRunning || isListening ? 'not-allowed' : 'pointer',
              opacity: isTransportRunning || isListening ? 0.6 : 1,
              transition: 'all 0.2s ease'
            }}
          >
            Jump
          </button>
        </div>

      </div>

      <div className="practice-info">
        <div style={{ marginBottom: '1rem', display: 'flex', gap: '2rem', alignItems: 'center' }}>
          <div style={{ color: '#333' }}>
            <strong style={{ color: '#667eea' }}>Pitch:</strong> {stabilizedPitch.frequencyHz ? `${stabilizedPitch.frequencyHz.toFixed(1)} Hz` : 'No pitch detected'}
            {stabilizedPitch.cents != null && (
              <span style={{ 
                color: Math.abs(stabilizedPitch.cents) < 10 ? '#2e8b57' : 
                       Math.abs(stabilizedPitch.cents) < 30 ? '#d1a000' : '#b44',
                fontWeight: 'bold'
              }}>
                {` (${stabilizedPitch.cents > 0 ? '+' : ''}${stabilizedPitch.cents.toFixed(1)} cents)`}
              </span>
            )}
          </div>
          <div style={{ color: '#333' }}>
            <strong style={{ color: '#667eea' }}>Target:</strong> {targetInfo.name ? `${targetInfo.name} (≈${targetInfo.hz?.toFixed(1)} Hz)` : '--'}
          </div>
          <div style={{ color: '#333' }}>
            <strong style={{ color: '#667eea' }}>Current Measure:</strong> 
            <span style={{ 
              color: currentMeasure === measureNumber ? '#2e8b57' : '#333',
              fontWeight: currentMeasure === measureNumber ? 'bold' : 'normal'
            }}>
              {currentMeasure}
            </span>
            {currentMeasure === measureNumber && (
              <span style={{ color: '#2e8b57', marginLeft: '0.5rem' }}>✓</span>
            )}
          </div>
        </div>
        
        {/* Real-time Accuracy Bar */}
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ color: '#333', marginBottom: '0.5rem' }}>
            <strong style={{ color: '#667eea' }}>Accuracy:</strong>
          </div>
          <div style={{ 
            width: '100%', 
            height: '20px', 
            backgroundColor: '#f0f0f0', 
            borderRadius: '10px',
            overflow: 'hidden',
            position: 'relative'
          }}>
            <div style={{
              width: '100%',
              height: '100%',
              background: stabilizedPitch.cents != null 
                ? `linear-gradient(to right, 
                    #2e8b57 0%, #2e8b57 ${Math.max(0, 10 - Math.abs(stabilizedPitch.cents)) * 10}%, 
                    #d1a000 ${Math.max(0, 10 - Math.abs(stabilizedPitch.cents)) * 10}%, #d1a000 ${Math.max(0, 30 - Math.abs(stabilizedPitch.cents)) * 3.33}%, 
                    #b44 ${Math.max(0, 30 - Math.abs(stabilizedPitch.cents)) * 3.33}%, #b44 100%)`
                : 'linear-gradient(to right, #f0f0f0 0%, #f0f0f0 100%)',
              transition: 'all 0.1s ease'
            }} />
            <div style={{
              position: 'absolute',
              left: '50%',
              top: '0',
              width: '2px',
              height: '100%',
              backgroundColor: '#333',
              transform: 'translateX(-50%)'
            }} />
          </div>
          <div style={{ 
            fontSize: '0.8rem', 
            color: '#666', 
            textAlign: 'center',
            marginTop: '0.25rem'
          }}>
            {stabilizedPitch.cents != null 
              ? 'Perfect | Close | Out of Tune'
              : 'No pitch detected - start playing to see accuracy'
            }
          </div>
        </div>
      </div>

      <div 
        className="sheet-container" 
        ref={wrapperRef}
        style={{ 
          position: 'relative'
        }}
      >
        <div ref={containerRef} style={{ minHeight: 400 }} />
        {noteMarks.map((mark, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: mark.x - 8,
              top: mark.y - 8,
              width: 16,
              height: 16,
              borderRadius: '50%',
              backgroundColor: mark.kind === 'correct' ? '#2e8b57' : mark.kind === 'incorrect' ? '#b44' : '#d1a000',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontSize: 12,
              fontWeight: 'bold',
            }}
          >
            {mark.kind === 'correct' ? '✓' : mark.kind === 'incorrect' ? '✗' : '?'}
          </div>
        ))}
      </div>
    </div>
  )
}


