'use client';

import React, { useState, useEffect, useRef } from 'react';

// TypeScript Interfaces
interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  image?: string; // Base64 encoding of clinical image
}

interface PatientRecord {
  id: string;
  name: string;
  video_path: string;
  timestamp: string;
  esi_level: number;
  priority_score: number;
  primary_diagnosis: string;
  is_shock: boolean;
  triage_summary: string;
  agent_output: string;
}

interface CameraDevice {
  index: number;
  label: string;
}

interface Metrics {
  bpm: number;
  confidence: number;
  status: string;
  snr_db: number;
  sqi: number;
  classification: string;
  ohi: number;
  stability: number;
  stability_indicator: string;
  rr: number;
  rr_confidence: number;
  rr_classification: string;
  hrv: number;
  stress_index: number;
  warnings: string[];
  remark: string;
  estimated_lux: number;
  motion_delta: number;
  is_live: boolean;
  calibration_done: boolean;
  ppg_signal: number[];
  calibration_progress: number;
  face_detected?: boolean;
}

const BACKEND_URL = "http://127.0.0.1:5002";

type NavigationTab = 'monitor' | 'queue' | 'crew';

export default function Home() {
  // Navigation
  const [activeTab, setActiveTab] = useState<NavigationTab>('monitor');
  const [isChatOpen, setIsChatOpen] = useState<boolean>(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false);

  // Connection and settings state
  const [backendOnline, setBackendOnline] = useState<boolean>(false);
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<number | null>(null);
  
  // Real-time metric states
  const [metrics, setMetrics] = useState<Metrics>({
    bpm: 0, confidence: 0, status: 'DISCONNECTED',
    snr_db: 0, sqi: 0, classification: 'UNKNOWN',
    ohi: 0, stability: 0, stability_indicator: '--',
    rr: 0, rr_confidence: 0, rr_classification: '--',
    hrv: 0, stress_index: 0, warnings: [],
    remark: '', estimated_lux: 0, motion_delta: 0,
    is_live: false, calibration_done: false, ppg_signal: [],
    calibration_progress: 0, face_detected: false
  });
  
  // Triage Queue & Multi-Agent Triage state
  const [triageQueue, setTriageQueue] = useState<PatientRecord[]>([]);
  const [isTriageRunning, setIsTriageRunning] = useState<boolean>(false);
  const [lastTriageResult, setLastTriageResult] = useState<PatientRecord | null>(null);
  const [activeAgentTab, setActiveAgentTab] = useState<'perception' | 'diagnostic' | 'coordinator'>('perception');
  
  // Chat state
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  
  // File upload state
  const [uploadMessage, setUploadMessage] = useState<{ text: string; type: 'success' | 'error' | '' }>({ text: '', type: '' });
  // Video feed reconnection key — incrementing forces img src reload
  const [videoFeedKey, setVideoFeedKey] = useState<number>(0);
  // 30-second session timer and auto-report
  const [sessionTimer, setSessionTimer] = useState<number>(30);
  const [sessionReport, setSessionReport] = useState<any>(null);
  const [reportLoading, setReportLoading] = useState<boolean>(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const reportFetchedRef = useRef<boolean>(false);
  
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [patientName, setPatientName] = useState<string>('');
  const [speechEnabled, setSpeechEnabled] = useState<boolean>(false); // Voice output disabled by default
  
  // Refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const sessionStartedRef = useRef<boolean>(false); // Prevent double auto-start
  
  // Polling intervals
  const statusPollInterval = useRef<NodeJS.Timeout | null>(null);

  // 1. Verify Backend Online and fetch cameras & queue
  const checkBackendStatus = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/cameras`);
      if (res.ok) {
        setBackendOnline(true);
        const data = await res.json();
        setCameras(data.cameras || []);
        if (data.default !== null && data.default !== undefined) {
          setSelectedCamera((prev) => prev !== null ? prev : data.default);
        }
        fetchQueue();
      } else {
        setBackendOnline(false);
        sessionStartedRef.current = false; // backend went offline, allow re-start
      }
    } catch (e) {
      setBackendOnline(false);
      sessionStartedRef.current = false;
    }
  };

  const fetchQueue = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/triage_queue`);
      if (res.ok) {
        const data = await res.json();
        setTriageQueue(data.queue || []);
      }
    } catch (e) {
      console.error("Error fetching triage queue:", e);
    }
  };

  useEffect(() => {
    checkBackendStatus();
    const interval = setInterval(checkBackendStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Set up status polling
  useEffect(() => {
    if (backendOnline) {
      statusPollInterval.current = setInterval(async () => {
        try {
          const res = await fetch(`${BACKEND_URL}/status`);
          if (res.ok) {
            const data = await res.json();
            setMetrics(data);
          }
        } catch (e) {
          console.error("Status poll error:", e);
        }
      }, 300);
    } else {
      if (statusPollInterval.current) clearInterval(statusPollInterval.current);
    }
    return () => {
      if (statusPollInterval.current) clearInterval(statusPollInterval.current);
    };
  }, [backendOnline]);

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, isChatLoading, activeTab]);

  // 30-second countdown timer — starts when calibration_done flips true
  useEffect(() => {
    if (metrics.calibration_done && metrics.is_live) {
      // Start countdown if not already running
      if (timerRef.current === null && sessionTimer <= 30 && !reportFetchedRef.current) {
        timerRef.current = setInterval(() => {
          setSessionTimer(prev => {
            if (prev <= 1) {
              // Time up — fetch report
              clearInterval(timerRef.current!);
              timerRef.current = null;
              if (!reportFetchedRef.current) {
                reportFetchedRef.current = true;
                setReportLoading(true);
                fetch(`${BACKEND_URL}/api/generate_report`, { method: 'POST' })
                  .then(r => r.json())
                  .then(d => { 
                    if (d.success) {
                      setSessionReport(d.report);
                      // Auto-run Clinical Crew triage with custom patient name
                      handleRunTriage(patientName);
                    }
                  })
                  .catch(console.error)
                  .finally(() => setReportLoading(false));
              }
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      }
    } else {
      // Reset on disconnect / new session
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (!metrics.calibration_done) {
        setSessionTimer(30);
        setSessionReport(null);
        reportFetchedRef.current = false;
      }
    }
    return () => {};
  }, [metrics.calibration_done, metrics.is_live, sessionReport]);

  // 2. Draw rPPG wave signal on HTML5 Canvas
  useEffect(() => {
    if (activeTab !== 'monitor') return; // Draw only when visible
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw background grid
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i < canvas.width; i += 40) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, canvas.height);
      ctx.stroke();
    }
    for (let i = 0; i < canvas.height; i += 30) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(canvas.width, i);
      ctx.stroke();
    }

    const signal = metrics.ppg_signal || [];
    if (signal.length === 0) {
      // Draw idle scanning line
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.2)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(0, canvas.height / 2);
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
      return;
    }

    // Smooth signal mapping
    const maxVal = Math.max(...signal);
    const minVal = Math.min(...signal);
    const range = maxVal - minVal || 1;

    // Shaded gradient area under the curve
    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    for (let i = 0; i < signal.length; i++) {
      const x = (i / (signal.length - 1)) * canvas.width;
      const y = canvas.height - 20 - ((signal[i] - minVal) / range) * (canvas.height - 40);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.closePath();
    
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, 'rgba(6, 182, 212, 0.20)');
    grad.addColorStop(1, 'rgba(6, 182, 212, 0.00)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw the neon stroke line
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.95)';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 12;
    ctx.shadowColor = 'rgba(6, 182, 212, 0.7)';

    for (let i = 0; i < signal.length; i++) {
      const x = (i / (signal.length - 1)) * canvas.width;
      const y = canvas.height - 20 - ((signal[i] - minVal) / range) * (canvas.height - 40);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.shadowBlur = 0; // reset
  }, [metrics.ppg_signal, metrics.status, activeTab]);

  // 3. Audio Recording STT / Voice Input
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const rec = new SpeechRecognition();
        rec.continuous = false;
        rec.interimResults = false;
        rec.lang = 'en-US';

        rec.onstart = () => setIsRecording(true);
        rec.onend = () => setIsRecording(false);
        rec.onerror = () => setIsRecording(false);
        rec.onresult = (event: any) => {
          const resultText = event.results[0][0].transcript;
          setChatInput(resultText);
        };
        recognitionRef.current = rec;
      }
    }
  }, []);

  const toggleRecording = () => {
    if (!recognitionRef.current) {
      alert("Speech Recognition API is not supported in this browser. Please type your query.");
      return;
    }
    if (isRecording) {
      recognitionRef.current.stop();
    } else {
      recognitionRef.current.start();
    }
  };

  // 4. Voice TTS output
  const speakText = (text: string) => {
    if (!speechEnabled) return;
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const cleanMsg = text.replace(/^\[[a-z]{2}-[A-Z]{2}\]\s*/i, '');
      const utterance = new SpeechSynthesisUtterance(cleanMsg);
      window.speechSynthesis.speak(utterance);
    }
  };

  // 5. Handlers
  const handleStartWebcam = async () => {
    setUploadMessage({ text: '', type: '' });
    try {
      const res = await fetch(`${BACKEND_URL}/start_webcam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: selectedCamera })
      });
      const data = await res.json();
      if (data.success) {
        setUploadMessage({ text: `Webcam session initialized.`, type: 'success' });
        // Force video feed img to reconnect (backend reset kills old MJPEG stream)
        setTimeout(() => setVideoFeedKey(k => k + 1), 400);
      } else {
        setUploadMessage({ text: data.error || 'Failed to start webcam.', type: 'error' });
      }
    } catch (e) {
      setUploadMessage({ text: 'Error starting webcam.', type: 'error' });
    }
  };

  const handleReleaseCamera = async () => {
    try {
      await fetch(`${BACKEND_URL}/release_camera`, { method: 'POST' });
      setUploadMessage({ text: 'Optical hardware released.', type: 'success' });
    } catch (e) {
      console.error(e);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];

    const formData = new FormData();
    formData.append('video', file);

    setUploadMessage({ text: 'Uploading intake media record...', type: 'success' });

    try {
      const res = await fetch(`${BACKEND_URL}/upload`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        setUploadMessage({ text: `Media loaded: ${data.message}`, type: 'success' });
      } else {
        setUploadMessage({ text: data.error || 'Upload failed.', type: 'error' });
      }
    } catch (err) {
      setUploadMessage({ text: 'Network error uploading file.', type: 'error' });
    }
  };

  const handleImageAttachment = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    
    const reader = new FileReader();
    reader.onloadend = () => {
      setSelectedImage(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleRunTriage = async (customName?: string) => {
    setIsTriageRunning(true);
    setLastTriageResult(null);
    try {
      const isLive = metrics.is_live || (metrics.status === 'OK' || metrics.status === 'CALIBRATING');
      const bodySource = isLive ? 'live' : '';
      const nameToSubmit = customName || patientName || '';
      
      let res;
      if (bodySource) {
        res = await fetch(`${BACKEND_URL}/api/triage_run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'live', patient_name: nameToSubmit })
        });
      } else {
        const formData = new FormData();
        formData.append('patient_name', nameToSubmit);
        res = await fetch(`${BACKEND_URL}/api/triage_run`, {
          method: 'POST',
          body: formData
        });
      }

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setLastTriageResult(data.patient_record);
          fetchQueue();
          setActiveAgentTab('coordinator');
        } else {
          alert(`Triage Crew failed: ${data.error}`);
        }
      } else {
        alert("Server error running Triage Crew.");
      }
    } catch (e) {
      alert(`Network error running Triage Crew: ${e}`);
    } finally {
      setIsTriageRunning(false);
    }
  };

  const handleClearQueue = async () => {
    if (!confirm("Are you sure you want to clear the entire triage queue?")) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/triage_queue`, { method: 'DELETE' });
      if (res.ok) {
        fetchQueue();
        setLastTriageResult(null);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSendChatMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() && !selectedImage) return;

    const userMsg: ChatMessage = { 
      role: 'user', 
      content: chatInput,
      image: selectedImage || undefined
    };
    
    const updatedHistory = [...chatHistory, userMsg];
    setChatHistory(updatedHistory);
    setChatInput('');
    setSelectedImage(null);
    setIsChatLoading(true);

    try {
      const res = await fetch(`${BACKEND_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: userMsg.content, 
          history: chatHistory.map(m => ({ role: m.role, content: m.content })),
          image: userMsg.image 
        })
      });
      const data = await res.json();
      if (data.response) {
        const modelMsg: ChatMessage = { role: 'model', content: data.response };
        setChatHistory([...updatedHistory, modelMsg]);
        speakText(data.response);
      } else {
        setChatHistory([...updatedHistory, { role: 'model', content: `Error: ${data.error || 'No response.'}` }]);
      }
    } catch (e) {
      setChatHistory([...updatedHistory, { role: 'model', content: 'Connection error connecting to ARIA.' }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  // UI Helpers
  const getEsiClass = (level: number) => {
    switch (level) {
      case 1: return 'bg-red-500/10 border-red-500 text-red-400 shadow-[0_0_15px_rgba(239,68,68,0.15)] animate-pulse';
      case 2: return 'bg-orange-500/10 border-orange-500 text-orange-400 shadow-[0_0_15px_rgba(245,158,11,0.1)]';
      case 3: return 'bg-yellow-500/10 border-yellow-500 text-yellow-400';
      case 4: return 'bg-emerald-500/10 border-emerald-500 text-emerald-400';
      case 5: return 'bg-cyan-500/10 border-cyan-500 text-cyan-400';
      default: return 'bg-zinc-800 border-zinc-700 text-zinc-300';
    }
  };

  const getHeartbeatDuration = () => {
    const rate = metrics.bpm > 0 ? metrics.bpm : 72;
    return `${60 / rate}s`;
  };

  return (
    <div className={`flex-1 font-sans min-h-screen pb-12 antialiased selection:bg-cyan-500 selection:text-black transition-colors duration-300 ${
      theme === 'light' ? 'light-theme bg-slate-50 text-slate-900' : 'dark-theme bg-black text-zinc-100'
    }`}>
      
      {/* Keyframe Injection for custom scanlines, glows, and animations */}
      <style jsx global>{`
        @keyframes scan {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100%); }
        }
        .animate-scan {
          animation: scan 6s linear infinite;
        }
        @keyframes pop-wave {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-6px) scale(1.05); }
        }
        .animate-pop-wave {
          animation: pop-wave 3s ease-in-out infinite;
        }
        @keyframes speech-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.03); opacity: 0.95; }
        }
        .animate-speech {
          animation: speech-pulse 2s ease-in-out infinite;
        }
        .shadow-glow-cyan {
          box-shadow: 0 0 20px rgba(6, 182, 212, 0.25);
        }
        .shadow-glow-red {
          box-shadow: 0 0 20px rgba(239, 68, 68, 0.3);
        }

        /* ── PURE PITCH-BLACK (OLED) DARK THEME STYLES ── */
        .dark-theme {
          background-color: #000000 !important;
          color: #f4f4f5 !important;
        }
        .dark-theme header,
        .dark-theme nav > div,
        .dark-theme .bg-\[\#090e1e\]\/60,
        .dark-theme .bg-\[\#090e1e\]\/80,
        .dark-theme .bg-\[\#070b19\]\/90,
        .dark-theme .bg-\[\#090e1e\],
        .dark-theme .bg-\[\#0b1329\],
        .dark-theme .bg-\[\#070e17\],
        .dark-theme .bg-\[\#0a0f1d\] {
          background-color: rgba(9, 9, 11, 0.95) !important;
          border-color: #18181b !important;
          box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.8) !important;
        }
        .dark-theme .bg-\[\#0b1022\],
        .dark-theme .bg-\[\#02040a\],
        .dark-theme .bg-\[\#02040a\]\/40,
        .dark-theme .bg-\[\#02040a\]\/50,
        .dark-theme .bg-\[\#02040a\]\/60,
        .dark-theme .bg-\[\#02040a\]f0,
        .dark-theme .bg-\[\#070b19\],
        .dark-theme .bg-\[\#060813\],
        .dark-theme .bg-\[\#030612\]\/30 {
          background-color: #000000 !important;
          border-color: #18181b !important;
          color: #f4f4f5 !important;
        }
        .dark-theme select,
        .dark-theme input[type="text"] {
          background-color: #000000 !important;
          border-color: #27272a !important;
          color: #ffffff !important;
        }
        .dark-theme select:focus,
        .dark-theme input[type="text"]:focus {
          border-color: #06b6d4 !important;
        }

        /* ── LIGHT THEME COMPLETE OVERHAUL STYLES ── */
        .light-theme {
          background-color: #f8fafc !important;
          color: #0f172a !important;
        }
        .light-theme header,
        .light-theme aside,
        .light-theme nav > div,
        .light-theme .bg-\[\#09090b\],
        .light-theme .bg-\[\#09090b\]\/90,
        .light-theme .bg-\[\#090e1e\]\/60,
        .light-theme .bg-\[\#090e1e\]\/80,
        .light-theme .bg-\[\#070b19\]\/90,
        .light-theme .bg-\[\#090e1e\],
        .light-theme .bg-\[\#0b1329\],
        .light-theme .bg-\[\#070e17\],
        .light-theme .bg-\[\#0a0f1d\] {
          background-color: #ffffff !important;
          border-color: #e2e8f0 !important;
          color: #0f172a !important;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.04), 0 2px 4px -2px rgba(0, 0, 0, 0.02) !important;
        }
        .light-theme header h1, 
        .light-theme header span,
        .light-theme header p,
        .light-theme aside span {
          color: #0f172a !important;
        }
        /* Sidebar & Header buttons */
        .light-theme aside button,
        .light-theme header button,
        .light-theme header div[class*="bg-"] {
          background-color: #f1f5f9 !important;
          border-color: #cbd5e1 !important;
          color: #0f172a !important;
        }
        .light-theme aside button:hover,
        .light-theme header button:hover {
          background-color: #e2e8f0 !important;
        }
        /* Active nav button in light theme */
        .light-theme aside button.bg-cyan-500\/10 {
          background-color: #e0f2fe !important;
          border-color: #0284c7 !important;
          color: #0369a1 !important;
          box-shadow: 0 0 10px rgba(2, 132, 199, 0.2) !important;
        }
        /* Internal sub-blocks */
        .light-theme .bg-\[\#02040a\],
        .light-theme .bg-\[\#02040a\]\/40,
        .light-theme .bg-\[\#02040a\]\/50,
        .light-theme .bg-\[\#02040a\]\/60,
        .light-theme .bg-\[\#02040a\]f0,
        .light-theme .bg-\[\#070b19\],
        .light-theme .bg-\[\#0b1022\],
        .light-theme .bg-\[\#060813\],
        .light-theme .bg-\[\#030612\]\/30,
        .light-theme .bg-\[\#000000\],
        .light-theme .bg-\[\#000000\]\/90,
        .light-theme .bg-\[\#000000\]\/80,
        .light-theme .bg-\[\#000000\]\/60 {
          background-color: #f8fafc !important;
          border-color: #e2e8f0 !important;
          color: #0f172a !important;
        }
        /* Border overrides */
        .light-theme .border-zinc-800,
        .light-theme .border-zinc-800\/80,
        .light-theme .border-zinc-850,
        .light-theme .border-zinc-800\/60,
        .light-theme .border-zinc-700\/80,
        .light-theme .border-indigo-800\/40,
        .light-theme .border-zinc-700,
        .light-theme .border-zinc-900 {
          border-color: #cbd5e1 !important;
        }
        /* Text color overrides */
        .light-theme .text-white,
        .light-theme .text-zinc-100,
        .light-theme .text-zinc-150,
        .light-theme .text-zinc-200,
        .light-theme .text-zinc-300 {
          color: #0f172a !important;
        }
        .light-theme .text-zinc-400,
        .light-theme .text-zinc-450,
        .light-theme .text-zinc-500,
        .light-theme .text-zinc-550,
        .light-theme .text-zinc-600,
        .light-theme .text-zinc-650 {
          color: #475569 !important;
        }
        /* Forms, inputs & select dropdowns */
        .light-theme select,
        .light-theme input[type="text"] {
          background-color: #ffffff !important;
          border-color: #cbd5e1 !important;
          color: #0f172a !important;
        }
        .light-theme select:focus,
        .light-theme input[type="text"]:focus {
          border-color: #0284c7 !important;
          box-shadow: 0 0 0 2px rgba(2, 132, 199, 0.15) !important;
        }
        /* Chat view message bubbles */
        .light-theme .bg-zinc-900\/60,
        .light-theme .bg-zinc-900 {
          background-color: #ffffff !important;
          color: #0f172a !important;
          border-color: #e2e8f0 !important;
          box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05) !important;
        }
        .light-theme .bg-indigo-950\/80,
        .light-theme .bg-indigo-600 {
          background-color: #0284c7 !important;
          color: #ffffff !important;
          border-color: #0284c7 !important;
        }
      `}</style>

      {/* 1. Main Header */}
      <header className="sticky top-0 z-50 bg-[#070b19]/90 backdrop-blur-xl border-b border-zinc-800/80 px-6 py-4 flex flex-wrap items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-zinc-950 flex items-center justify-center shadow-lg shadow-cyan-500/20 relative overflow-hidden border border-zinc-800">
            <img src="/vital_logo.png" alt="VITAL Logo" className="w-full h-full object-cover" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-white flex items-center gap-2.5">
              VITAL
            </h1>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mt-0.5">Vision-Based Intelligent Triage &amp; Autonomous Lifesign Analytics</p>
          </div>
        </div>

        {/* Server status monitor */}
        <div className="flex items-center gap-4">
          {/* ARIA indicator */}
          <div className="hidden md:flex items-center gap-2 text-xs bg-[#0b1022] border border-indigo-800/40 rounded-lg px-3 py-1.5">
            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
            <span className="text-indigo-400 font-black uppercase tracking-widest text-[10px]">ARIA ONLINE</span>
          </div>
          <div className="flex items-center gap-2 text-sm bg-[#0b1022] border border-zinc-800 rounded-lg px-4 py-2">
            <span className="text-zinc-500 uppercase tracking-wider font-mono text-[10px] font-bold">System:</span>
            {backendOnline ? (
              <span className="flex items-center gap-1.5 font-extrabold text-emerald-400 text-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.5)]"></span>
                ONLINE
              </span>
            ) : (
              <span className="flex items-center gap-1.5 font-extrabold text-rose-500 text-xs">
                <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                OFFLINE
              </span>
            )}
          </div>
          <div className="w-px h-6 bg-zinc-800"></div>
          <div className="text-xs bg-[#0b1022] border border-zinc-800 rounded-lg px-4 py-2 font-mono uppercase tracking-wider">
            <span className="text-zinc-500">Queue</span>
            <span className="font-black text-cyan-400 ml-2 text-sm">{triageQueue.length}</span>
          </div>
          <div className="w-px h-6 bg-zinc-800"></div>
          {/* Theme Toggle Button */}
          <button
            onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
            className="flex items-center justify-center p-2 bg-[#0b1022] border border-zinc-800 rounded-lg hover:bg-zinc-800/50 hover:border-zinc-700 transition-colors"
            title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
          >
            {theme === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-amber-400">
                <circle cx="12" cy="12" r="5"/>
                <line x1="12" y1="1" x2="12" y2="3"/>
                <line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/>
                <line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-indigo-400">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* 2. Main Workspace Layout with Left Sliding Sidebar */}
      <main className="max-w-[1700px] mx-auto px-6 mt-6 pb-10 flex flex-col lg:flex-row gap-6 items-start">
        
        {/* Left Sliding Vertical Navigation Sidebar */}
        <aside className={`shrink-0 transition-all duration-300 ${isSidebarCollapsed ? 'w-full lg:w-16 px-2' : 'w-full lg:w-64 px-3'} bg-[#09090b]/90 border border-zinc-800 rounded-2xl py-3 backdrop-blur-xl shadow-2xl flex flex-col gap-2`}>
          
          {/* Collapse / Expand Toggle Header */}
          <div className={`flex items-center ${isSidebarCollapsed ? 'justify-center' : 'justify-between'} px-1 py-1.5 border-b border-zinc-800/80 mb-1`}>
            {!isSidebarCollapsed && (
              <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest px-1">Navigation</span>
            )}
            <button 
              onClick={() => setIsSidebarCollapsed(prev => !prev)}
              className="p-2 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition-colors flex items-center justify-center"
              title={isSidebarCollapsed ? "Expand Navigation Bar" : "Collapse Navigation Bar (Slide Left)"}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform duration-300 ${isSidebarCollapsed ? 'rotate-180' : ''}`}>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          </div>

          {/* Nav Tab 1: Vitals Monitor */}
          <button
            onClick={() => setActiveTab('monitor')}
            className={`py-3 ${isSidebarCollapsed ? 'justify-center px-0 w-full' : 'px-3.5 gap-3'} rounded-xl flex items-center transition-all text-xs font-black uppercase tracking-wider ${
              activeTab === 'monitor' 
                ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 shadow-glow-cyan' 
                : 'text-zinc-400 hover:text-zinc-100 border border-transparent hover:bg-zinc-800/40'
            }`}
            title="Vitals Monitor"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            {!isSidebarCollapsed && <span className="truncate">Vitals Monitor</span>}
          </button>

          {/* Nav Tab 2: Triage Dispatch */}
          <button
            onClick={() => setActiveTab('queue')}
            className={`py-3 ${isSidebarCollapsed ? 'justify-center px-0 w-full relative' : 'px-3.5 justify-between gap-3'} rounded-xl flex items-center transition-all text-xs font-black uppercase tracking-wider ${
              activeTab === 'queue' 
                ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 shadow-glow-cyan' 
                : 'text-zinc-400 hover:text-zinc-100 border border-transparent hover:bg-zinc-800/40'
            }`}
            title="Triage Dispatch"
          >
            <div className="flex items-center gap-3">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
              {!isSidebarCollapsed && <span className="truncate">Triage Dispatch</span>}
            </div>
            {triageQueue.length > 0 && (
              <span className={`${isSidebarCollapsed ? 'absolute top-1 right-1' : ''} bg-cyan-500 text-black text-[9px] font-black px-1.5 py-0.5 rounded-full leading-none shrink-0`}>
                {triageQueue.length}
              </span>
            )}
          </button>

          {/* Nav Tab 3: Clinical Crew */}
          <button
            onClick={() => setActiveTab('crew')}
            className={`py-3 ${isSidebarCollapsed ? 'justify-center px-0 w-full' : 'px-3.5 gap-3'} rounded-xl flex items-center transition-all text-xs font-black uppercase tracking-wider ${
              activeTab === 'crew' 
                ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 shadow-glow-cyan' 
                : 'text-zinc-400 hover:text-zinc-100 border border-transparent hover:bg-zinc-800/40'
            }`}
            title="Clinical Crew"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            {!isSidebarCollapsed && <span className="truncate">Clinical Crew</span>}
          </button>

        </aside>

        {/* Workspace Views Container */}
        <div className="flex-1 w-full min-w-0">
        
        {/* VIEW 1: LIVE VITAL MONITOR */}
        {activeTab === 'monitor' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            
            {/* Left Hand side: Camera Feed Controls (expanded to col-span-7) */}
            <div className="lg:col-span-7 flex flex-col gap-6">
              <div className="bg-[#090e1e]/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-xl shadow-xl flex flex-col relative overflow-hidden">
                <h2 className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-4 flex items-center gap-2.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping"></span>
                  Intake Acquisition Feed
                </h2>

                <div className="relative min-h-[420px] bg-[#02040a] border border-zinc-800 rounded-xl overflow-hidden mb-4 group flex items-center justify-center shadow-inner">
                  {backendOnline ? (
                    metrics.status === 'IMAGE_READY' || metrics.remark === 'IMAGE_DEMO' ? (
                      <img 
                        src={`${BACKEND_URL}/image_feed`} 
                        alt="Intake snap" 
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <img 
                        key={videoFeedKey}
                        src={`${BACKEND_URL}/video_feed?t=${videoFeedKey}`} 
                        alt="Medical Stream" 
                        className="w-full h-full object-contain"
                        onError={() => {
                          // Auto-retry connection after 1s if stream breaks
                          setTimeout(() => setVideoFeedKey(k => k + 1), 1000);
                        }}
                      />
                    )
                  ) : (
                    <div className="text-center p-6 text-zinc-500 max-w-[320px]">
                      <div className="text-3xl mb-3">📡</div>
                      <p className="text-sm font-bold text-zinc-300">Intake Hardware Offline</p>
                      <p className="text-xs text-zinc-500 mt-2 leading-relaxed">Ensure Python backend API server is running on port 5002 with required dependencies.</p>
                    </div>
                  )}

                  {/* Laser scan overlay */}
                  {(metrics.status === 'CALIBRATING' || metrics.status === 'OK') && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden">
                      <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent shadow-[0_0_10px_#06b6d4] opacity-60 absolute animate-scan"></div>
                    </div>
                  )}

                  {/* Floating acquisition state tags */}
                  <div className="absolute top-4 left-4 flex flex-wrap gap-2 pointer-events-none">
                    <span className={`text-[10px] font-extrabold uppercase px-2.5 py-1 rounded-md border ${
                      metrics.status === 'OK' ? 'bg-emerald-950/90 text-emerald-400 border-emerald-800/80 shadow-[0_0_10px_rgba(52,211,153,0.2)]' :
                      metrics.status === 'CALIBRATING' ? 'bg-cyan-950/90 text-cyan-400 border-cyan-800/80 animate-pulse' :
                      metrics.status === 'VIDEO_ENDED' ? 'bg-zinc-900/90 text-zinc-400 border-zinc-700/80' :
                      metrics.status === 'IMAGE_READY' ? 'bg-purple-950/90 text-purple-400 border-purple-800/80' :
                      'bg-zinc-950/90 text-zinc-500 border-zinc-800'
                    }`}>
                      {metrics.status}
                    </span>
                    
                    {metrics.face_detected && (
                      <span className="text-[10px] bg-cyan-950/95 text-cyan-400 border border-cyan-800/80 px-2.5 py-1 rounded-md font-extrabold tracking-wider">
                        TARGET DETECTED
                      </span>
                    )}
                  </div>
                </div>

                {/* Controller section */}
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] text-zinc-450 font-black uppercase tracking-wider">Patient Identification (Full Name)</label>
                    <input 
                      type="text" 
                      placeholder="Enter patient full name (e.g. John Doe)..." 
                      value={patientName}
                      onChange={(e) => setPatientName(e.target.value)}
                      className="bg-[#02040a] border border-zinc-800 rounded-lg text-sm p-2.5 text-zinc-300 outline-none focus:border-cyan-500 transition-colors"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] text-zinc-450 font-black uppercase tracking-wider">Optical Device</label>
                      <select 
                        value={selectedCamera !== null ? selectedCamera : ''}
                        onChange={(e) => setSelectedCamera(Number(e.target.value))}
                        className="bg-[#02040a] border border-zinc-800 rounded-lg text-sm p-2.5 text-zinc-300 outline-none focus:border-cyan-500 transition-colors cursor-pointer"
                      >
                        {cameras.map((cam) => (
                          <option key={cam.index} value={cam.index}>{cam.label}</option>
                        ))}
                        {cameras.length === 0 && <option value="">No hardware found</option>}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] text-zinc-450 font-black uppercase tracking-wider">Interface controls</label>
                      <div className="flex gap-2">
                        <button 
                          onClick={handleStartWebcam}
                          className="flex-1 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 hover:border-cyan-500/60 font-bold text-xs py-2.5 px-3 rounded-lg transition-all shadow-glow-cyan"
                        >
                          Init Sensors
                        </button>
                        <button 
                          onClick={metrics.is_live ? handleReleaseCamera : handleStartWebcam}
                          title={metrics.is_live ? "Release Hardware (Stop)" : "Initialize Hardware (Play)"}
                          className={`px-4 py-2 border rounded-lg transition-colors flex items-center justify-center font-bold text-xs ${
                            metrics.is_live 
                              ? 'bg-rose-950/20 hover:bg-rose-900/20 border-rose-800/40 text-rose-400 shadow-[0_0_10px_rgba(244,63,94,0.1)]' 
                              : 'bg-emerald-950/20 hover:bg-emerald-900/20 border-emerald-800/40 text-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.1)]'
                          }`}
                        >
                          {metrics.is_live ? '⏹' : '▶'}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] text-zinc-450 font-black uppercase tracking-wider">Upload Record (Video / Image)</label>
                    <div className="relative border border-dashed border-zinc-850 hover:border-zinc-700 bg-[#02040a]/40 hover:bg-[#02040a]/75 rounded-lg p-4 text-center cursor-pointer transition-all">
                      <input 
                        type="file" 
                        accept="video/*,image/*" 
                        onChange={handleFileUpload}
                        className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                      />
                      <div className="text-zinc-300 text-sm font-semibold">
                        📂 Choose patient media file...
                      </div>
                      <p className="text-[9px] text-zinc-550 mt-1 uppercase tracking-wider font-mono">Supports MP4, webm, jpg, png</p>
                    </div>
                  </div>

                  {uploadMessage.text && (
                    <div className={`text-xs p-3 rounded-md font-bold ${
                      uploadMessage.type === 'success' ? 'bg-emerald-950/40 text-emerald-400 border border-emerald-900/30' : 'bg-rose-950/40 text-rose-400 border border-rose-900/30'
                    }`}>
                      {uploadMessage.text}
                    </div>
                  )}

                  {/* ── Signal Telemetry & Diagnostics ── unique hospital-grade widget */}
                  <div className="mt-2 bg-[#02040a]/60 border border-zinc-800/60 rounded-xl p-4">
                    <div className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
                        Signal Telemetry &amp; Diagnostics
                      </div>
                      <span className="font-mono text-[8px] text-zinc-650 bg-[#070b19] px-1.5 py-0.5 rounded border border-zinc-800">CHROM v2</span>
                    </div>

                    <div className="space-y-2 font-mono text-[10px]">
                      <div className="flex justify-between items-center py-1 border-b border-zinc-800/30">
                        <span className="text-zinc-500 uppercase">Camera Status</span>
                        <span className={`font-black uppercase ${metrics.is_live ? 'text-emerald-450' : 'text-zinc-600'}`}>
                          {metrics.is_live ? 'ACTIVE (30 FPS)' : 'OFFLINE'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center py-1 border-b border-zinc-800/30">
                        <span className="text-zinc-500 uppercase">Face ROI Lock</span>
                        <span className={`font-black uppercase ${metrics.face_detected ? 'text-cyan-450' : 'text-zinc-600'}`}>
                          {metrics.face_detected ? 'LOCKED (142x44px)' : 'NO LOCK'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center py-1 border-b border-zinc-800/30">
                        <span className="text-zinc-500 uppercase">Ambient Light</span>
                        <span className={`font-black uppercase ${metrics.estimated_lux > 100 ? 'text-emerald-450' : 'text-amber-450'}`}>
                          {metrics.estimated_lux} LUX ({metrics.estimated_lux > 100 ? 'OPTIMAL' : 'LOW'})
                        </span>
                      </div>
                      <div className="flex justify-between items-center py-1 border-b border-zinc-800/30">
                        <span className="text-zinc-500 uppercase">Signal Stability</span>
                        <span className="text-white font-black">{metrics.stability > 0 ? `${metrics.stability.toFixed(0)}%` : '--'}</span>
                      </div>
                      <div className="flex justify-between items-center py-1">
                        <span className="text-zinc-500 uppercase">Noise Level (SNR)</span>
                        <span className="text-indigo-400 font-black">{metrics.snr_db > 0 ? `${Number(metrics.snr_db).toFixed(1)} dB` : '--'}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Hand side: Vital Signs grid & PPG Plot (shrunk to col-span-5) */}
            <div className="lg:col-span-5 flex flex-col gap-6">
              
              {isTriageRunning && (
                <div className="bg-[#090e1e]/80 border border-indigo-500/40 rounded-2xl p-5 backdrop-blur-xl shadow-xl flex items-center gap-4 animate-pulse">
                  <div className="w-8 h-8 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin shrink-0"></div>
                  <div>
                    <h3 className="text-xs font-black text-indigo-400 uppercase tracking-widest">Clinical Crew Running</h3>
                    <p className="text-[10px] text-zinc-450 uppercase font-bold mt-1 leading-relaxed">
                      3-Agent pipeline is executing diagnostics, ESI acuity check, and saving record to Neon.
                    </p>
                  </div>
                </div>
              )}
              
              {/* VITALS GRID */}
              <div className="bg-[#090e1e]/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-xl shadow-xl">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xs font-black text-zinc-400 uppercase tracking-widest flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                    Optical Physiology Indicators
                  </h2>
                  {/* 30-sec session acquisition timer */}
                  <div className="flex items-center gap-2 ml-auto">
                    {metrics.calibration_done && sessionTimer > 0 && (
                      <div className="flex items-center gap-2 bg-[#02040a] border border-cyan-800/40 rounded-lg px-3 py-1.5">
                        <svg width="28" height="28" viewBox="0 0 36 36" className="-rotate-90">
                          <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(6,182,212,0.15)" strokeWidth="3"/>
                          <circle cx="18" cy="18" r="14" fill="none" stroke="#06b6d4" strokeWidth="3"
                            strokeDasharray={`${2 * Math.PI * 14}`}
                            strokeDashoffset={`${2 * Math.PI * 14 * (1 - sessionTimer / 30)}`}
                            strokeLinecap="round" style={{transition: 'stroke-dashoffset 1s linear'}}/>
                          <text x="18" y="23" textAnchor="middle" fill="#06b6d4" fontSize="10" fontWeight="900"
                            style={{transform: 'rotate(90deg)', transformOrigin: '18px 18px'}}>{sessionTimer}</text>
                        </svg>
                        <div className="text-right">
                          <div className="text-[9px] text-zinc-500 font-black uppercase tracking-widest">Scan Window</div>
                          <div className="text-[11px] text-cyan-400 font-black">{sessionTimer}s remaining</div>
                        </div>
                      </div>
                    )}
                    {sessionTimer === 0 && !reportLoading && sessionReport && (
                      <div className="text-[10px] bg-emerald-950/60 border border-emerald-800/50 text-emerald-400 px-3 py-1.5 rounded-lg font-black uppercase tracking-widest flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        Report Ready
                      </div>
                    )}
                    {reportLoading && (
                      <div className="text-[10px] text-cyan-400 font-black uppercase tracking-widest flex items-center gap-1.5 animate-pulse">
                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping"></span>
                        Compiling Report...
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  
                  {/* HEART RATE */}
                  <div className={`bg-[#02040a]/50 border rounded-xl p-5 flex flex-col justify-between hover:border-zinc-700 transition-all ${
                    metrics.classification === 'TACHYCARDIA' ? 'border-rose-500/40 bg-rose-950/5 shadow-glow-red' :
                    metrics.classification === 'NORMAL' ? 'border-emerald-500/20' :
                    'border-zinc-800'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-zinc-400 font-extrabold uppercase tracking-wider">Heart Rate</span>
                      <span 
                        className="text-sm text-rose-500 transition-all transform origin-center animate-ping"
                        style={{ animationDuration: getHeartbeatDuration() }}
                      >
                        ❤️
                      </span>
                    </div>
                    <div className="my-3 flex items-baseline gap-2">
                      <span className="text-5xl font-black text-white tracking-tight leading-none font-mono">
                        {metrics.bpm > 0 ? metrics.bpm : '--'}
                      </span>
                      <span className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider">BPM</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-zinc-850 pt-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded font-extrabold uppercase tracking-widest ${
                        metrics.classification === 'NORMAL' ? 'bg-emerald-950/80 text-emerald-450 border border-emerald-900/60' :
                        metrics.classification === 'TACHYCARDIA' ? 'bg-rose-950/80 text-rose-450 border border-rose-900/60 shadow-glow-red' :
                        metrics.classification === 'BRADYCARDIA' ? 'bg-cyan-950/80 text-cyan-450 border border-cyan-900/60' :
                        'bg-zinc-900 text-zinc-500'
                      }`}>
                        {metrics.classification}
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono">Conf: {typeof metrics.confidence === 'number' ? metrics.confidence.toFixed(1) : metrics.confidence}%</span>
                    </div>
                  </div>

                  {/* RESPIRATORY RATE */}
                  <div className={`bg-[#02040a]/50 border rounded-xl p-5 flex flex-col justify-between hover:border-zinc-700 transition-all ${
                    metrics.rr_classification === 'TACHYPNEA' ? 'border-rose-500/40 bg-rose-950/5' :
                    metrics.rr_classification === 'NORMAL' ? 'border-emerald-500/20' :
                    'border-zinc-800'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-zinc-400 font-extrabold uppercase tracking-wider">Respiration</span>
                      <span className="text-sm text-cyan-450 animate-pulse">🌬️</span>
                    </div>
                    <div className="my-3 flex items-baseline gap-2 overflow-hidden">
                      <span className="text-5xl font-black text-white tracking-tight leading-none font-mono truncate">
                        {metrics.rr > 0 ? Number(metrics.rr).toFixed(1) : '--'}
                      </span>
                      <span className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider shrink-0">B/min</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-zinc-850 pt-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded font-extrabold uppercase tracking-widest ${
                        metrics.rr_classification === 'NORMAL' ? 'bg-emerald-950/80 text-emerald-450 border border-emerald-900/60' :
                        metrics.rr_classification === 'TACHYPNEA' ? 'bg-rose-950/80 text-rose-450 border border-rose-900/60' :
                        metrics.rr_classification === 'BRADYPNEA' ? 'bg-cyan-950/80 text-cyan-450 border border-cyan-900/60' :
                        'bg-zinc-900 text-zinc-500'
                      }`}>
                        {metrics.rr_classification}
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono">Conf: {typeof metrics.rr_confidence === 'number' ? Number(metrics.rr_confidence).toFixed(1) : metrics.rr_confidence}%</span>
                    </div>
                  </div>

                  {/* STRESS INDEX */}
                  <div className={`bg-[#02040a]/50 border rounded-xl p-5 flex flex-col justify-between hover:border-zinc-700 transition-all ${
                    metrics.stress_index > 150 ? 'border-rose-500/40 bg-rose-950/5' :
                    metrics.stress_index > 80 ? 'border-amber-500/30 bg-amber-950/5' :
                    'border-zinc-800'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-zinc-400 font-extrabold uppercase tracking-wider">Stress Index</span>
                      <span className="text-sm text-yellow-500">⚡</span>
                    </div>
                    <div className="my-3 flex items-baseline gap-2 overflow-hidden">
                      <span className={`font-black text-white tracking-tight leading-none font-mono ${
                        metrics.stress_index > 999 ? 'text-3xl' : 'text-5xl'
                      }`}>
                        {metrics.stress_index > 0 ? Number(metrics.stress_index).toFixed(0) : '--'}
                      </span>
                      <span className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider shrink-0">INDEX</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-zinc-850 pt-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded font-extrabold uppercase tracking-widest ${
                        metrics.stress_index > 150 ? 'bg-rose-950/80 text-rose-450' :
                        metrics.stress_index > 80 ? 'bg-amber-950/80 text-amber-450' :
                        metrics.stress_index > 0 ? 'bg-emerald-950/80 text-emerald-450' :
                        'bg-zinc-900 text-zinc-500'
                      }`}>
                        {metrics.stress_index > 150 ? 'CRITICAL' : metrics.stress_index > 80 ? 'ELEVATED' : metrics.stress_index > 0 ? 'OPTIMAL' : '--'}
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono">HRV: {typeof metrics.hrv === 'number' ? Number(metrics.hrv).toFixed(0) : '--'}ms</span>
                    </div>
                  </div>

                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                  {/* SIGNAL QUALITY & SNR */}
                  <div className="bg-[#02040a]/50 border border-zinc-800 rounded-xl p-4 flex items-center justify-between hover:border-zinc-700 transition-all">
                    <div>
                      <span className="text-[10px] text-zinc-500 font-extrabold uppercase tracking-wider">Signal SNR</span>
                      <div className="text-2xl font-black text-white font-mono mt-1">{metrics.snr_db ? `${metrics.snr_db.toFixed(1)} dB` : '--'}</div>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] text-zinc-500 font-extrabold uppercase tracking-wider">Stability</span>
                      <div className="text-sm font-bold text-cyan-400 font-mono mt-1">{metrics.stability_indicator} ({metrics.stability.toFixed(1)} bpm)</div>
                    </div>
                  </div>

                  {/* LIGHT & MOTION */}
                  <div className="bg-[#02040a]/50 border border-zinc-800 rounded-xl p-4 flex items-center justify-between hover:border-zinc-700 transition-all">
                    <div>
                      <span className="text-[10px] text-zinc-500 font-extrabold uppercase tracking-wider">Acquisition Environment</span>
                      <div className="text-sm font-extrabold text-zinc-300 mt-1 flex flex-col gap-0.5">
                        <span>Luminance: <strong className="text-white font-mono">{metrics.estimated_lux} LUX</strong></span>
                        <span>Motion: <strong className="text-white font-mono">{metrics.motion_delta.toFixed(1)}</strong></span>
                      </div>
                    </div>
                    <div className="text-[10px] text-zinc-550 text-right leading-relaxed font-semibold">
                      <div>LIMIT: &gt;100 LUX</div>
                      <div>MOTION: &lt;15.0</div>
                    </div>
                  </div>
                </div>

                {metrics.warnings && metrics.warnings.length > 0 && (
                  <div className="mt-4 p-4 bg-rose-950/20 border border-rose-900/40 rounded-xl flex flex-col gap-1.5 shadow-glow-red animate-pulse">
                    <div className="text-xs font-black text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
                      ⚠ Telemetry acquisition warnings:
                    </div>
                    <ul className="list-disc list-inside text-xs text-rose-300 font-semibold leading-relaxed">
                      {metrics.warnings.map((w, idx) => <li key={idx}>{w}</li>)}
                    </ul>
                  </div>
                )}
              </div>

              {/* 30-SECOND SESSION REPORT */}
              {sessionReport && (
                <div className="bg-[#090e1e]/80 border border-emerald-800/40 rounded-2xl p-5 backdrop-blur-xl shadow-xl animate-in fade-in duration-500">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                      <h3 className="text-xs font-black text-emerald-400 uppercase tracking-widest">30-Second Clinical Session Report</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] text-zinc-500 font-mono uppercase">{sessionReport.generated_at}</span>
                      <button onClick={() => { setSessionReport(null); setSessionTimer(30); reportFetchedRef.current = false; }}
                        className="text-zinc-600 hover:text-zinc-400 text-xs px-2 py-0.5 rounded border border-zinc-800 hover:border-zinc-700 transition-colors font-mono">
                        ✕
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    <div className="bg-[#02040a] border border-zinc-800 rounded-xl p-3 text-center">
                      <div className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Avg BPM</div>
                      <div className="text-2xl font-black font-mono text-white">{sessionReport.vitals.heart_rate_avg ?? '--'}</div>
                      <div className={`text-[9px] mt-1 font-black uppercase tracking-widest ${
                        sessionReport.vitals.classification === 'NORMAL' ? 'text-emerald-400' :
                        sessionReport.vitals.classification === 'TACHYCARDIA' ? 'text-rose-400' : 'text-cyan-400'
                      }`}>{sessionReport.vitals.classification}</div>
                    </div>
                    <div className="bg-[#02040a] border border-zinc-800 rounded-xl p-3 text-center">
                      <div className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Respiration</div>
                      <div className="text-2xl font-black font-mono text-white">{sessionReport.vitals.respiratory_rate ?? '--'}</div>
                      <div className="text-[9px] mt-1 font-black uppercase tracking-widest text-cyan-400">{sessionReport.vitals.rr_classification}</div>
                    </div>
                    <div className="bg-[#02040a] border border-zinc-800 rounded-xl p-3 text-center">
                      <div className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold mb-1">HRV (RMSSD)</div>
                      <div className="text-2xl font-black font-mono text-indigo-400">{sessionReport.vitals.hrv_rmssd_ms ?? '--'}</div>
                      <div className="text-[9px] mt-1 font-bold text-zinc-500 uppercase">ms</div>
                    </div>
                    <div className="bg-[#02040a] border border-zinc-800 rounded-xl p-3 text-center">
                      <div className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Stress</div>
                      <div className={`text-2xl font-black font-mono ${
                        sessionReport.vitals.stress_label === 'CRITICAL' ? 'text-rose-400' :
                        sessionReport.vitals.stress_label === 'ELEVATED' ? 'text-amber-400' : 'text-emerald-400'
                      }`}>{sessionReport.vitals.stress_index ?? '--'}</div>
                      <div className={`text-[9px] mt-1 font-black uppercase tracking-widest ${
                        sessionReport.vitals.stress_label === 'CRITICAL' ? 'text-rose-400' :
                        sessionReport.vitals.stress_label === 'ELEVATED' ? 'text-amber-400' : 'text-emerald-400'
                      }`}>{sessionReport.vitals.stress_label}</div>
                    </div>
                  </div>

                  <div className="bg-[#02040a]/80 border border-zinc-800/60 rounded-xl p-4 mb-3">
                    <div className="text-[9px] text-zinc-500 font-black uppercase tracking-widest mb-2">Clinical Interpretation</div>
                    <p className="text-sm text-zinc-300 leading-relaxed font-semibold">{sessionReport.clinical_summary}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-4 text-[9px] text-zinc-600 font-bold uppercase tracking-wider">
                    <span>Confidence: <strong className="text-zinc-400">{sessionReport.signal_quality.confidence_pct}%</strong></span>
                    <span>SNR: <strong className="text-zinc-400">{sessionReport.signal_quality.snr_db ?? '--'} dB</strong></span>
                    <span>Stability: <strong className="text-zinc-400">{sessionReport.signal_quality.stability}</strong></span>
                    <span>Lux: <strong className="text-zinc-400">{sessionReport.signal_quality.luminance_lux}</strong></span>
                    <span className="text-zinc-700">· {sessionReport.disclaimer}</span>
                  </div>
                </div>
              )}

              {/* RPPG CANVAS GRAPH */}

              <div className="bg-[#090e1e]/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-xl shadow-xl flex-1 flex flex-col relative overflow-hidden">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-xs font-black text-zinc-400 uppercase tracking-widest flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse shadow-glow-cyan"></span>
                    rPPG Photonic Waveform analysis
                  </h2>
                  <span className="text-xs text-zinc-500 font-mono tracking-widest uppercase">
                    {metrics.sqi > 0 ? `SQI: ${metrics.sqi}%` : 'Calibrating signals...'}
                  </span>
                </div>
                
                <div className="relative bg-[#02040a] border border-zinc-800 rounded-xl p-2 flex items-center justify-center overflow-hidden flex-1 min-h-[220px]">
                  <canvas 
                    ref={canvasRef} 
                    width={640} 
                    height={220} 
                    className="w-full h-full block"
                  />
                  
                  {metrics.status === 'CALIBRATING' && (
                    <div className="absolute inset-0 bg-[#02040ad0]/95 flex flex-col items-center justify-center p-4">
                      <div className="w-full max-w-sm bg-zinc-900 rounded-full h-2 overflow-hidden border border-zinc-800 mb-4 relative">
                        <div 
                          className="bg-gradient-to-r from-cyan-400 to-indigo-500 h-full rounded-full transition-all duration-300 shadow-[0_0_10px_rgba(6,182,212,0.6)]"
                          style={{ width: `${metrics.calibration_progress}%` }}
                        ></div>
                      </div>
                      <span className="text-xs text-cyan-400 font-black tracking-widest animate-pulse uppercase">
                        Calibrating Photonic Sensors ({metrics.calibration_progress}%)
                      </span>
                    </div>
                  )}
                </div>
                
                <div className="flex items-center justify-between text-[10px] text-zinc-550 mt-2 font-mono uppercase tracking-widest font-bold">
                  <span>0.00s</span>
                  <span>10s Rolling Sensor Buffer</span>
                  <span>10.00s</span>
                </div>
              </div>

            </div>

          </div>
        )}

        {/* VIEW 2: CENTRAL TRIAGE QUEUE */}
        {activeTab === 'queue' && (
          <div className="bg-[#090e1e]/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-xl shadow-xl flex flex-col min-h-[550px] relative overflow-hidden">
            
            <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-6">
              <div>
                <h2 className="text-base font-black text-white uppercase tracking-wider flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 shadow-glow-cyan"></span>
                  Central Dispatch Triage Queue
                </h2>
                <p className="text-xs text-zinc-450 uppercase tracking-wider font-bold mt-1">Dynamically sorted by Acuity (ESI 1 & 2 prioritize to the top)</p>
              </div>
              <button 
                onClick={handleClearQueue}
                className="text-rose-450 hover:text-rose-400 hover:bg-rose-950/40 border border-rose-900/40 text-xs font-black uppercase tracking-widest py-2 px-5 rounded-lg transition-colors"
              >
                Flush Queue
              </button>
            </div>

            <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1">
              {triageQueue.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-zinc-500 py-24 text-center text-sm font-bold uppercase tracking-widest">
                  <div className="text-4xl mb-3">📋</div>
                  <p className="text-zinc-300">Clinical Queue Empty</p>
                  <p className="text-[10px] text-zinc-550 mt-1 uppercase font-mono">Processed ESI patient records will compile here.</p>
                </div>
              ) : (
                triageQueue.map((patient) => (
                  <div 
                    key={patient.id} 
                    className={`border border-zinc-800 rounded-xl p-5 bg-[#02040a]/40 hover:bg-[#02040a]/75 transition-all flex flex-col md:flex-row md:items-center justify-between gap-6 relative overflow-hidden group ${
                      patient.is_shock ? 'border-rose-500/50 shadow-glow-red bg-rose-950/5' : 'hover:border-zinc-700'
                    }`}
                  >
                    {/* Urgency Sidebar Indicator */}
                    <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${
                      patient.esi_level === 1 ? 'bg-red-500' :
                      patient.esi_level === 2 ? 'bg-orange-500' :
                      patient.esi_level === 3 ? 'bg-yellow-500' :
                      patient.esi_level === 4 ? 'bg-emerald-500' :
                      'bg-cyan-500'
                    }`}></div>

                    <div className="flex-1 pl-3">
                      <div className="flex flex-wrap items-center gap-4">
                        <span className="font-black text-white text-base">{patient.name}</span>
                        <span className="text-xs font-mono text-zinc-550 font-bold uppercase">{patient.timestamp}</span>
                        {patient.is_shock && (
                          <span className="text-[10px] bg-red-950 text-red-400 border border-red-900/60 px-2.5 py-0.5 rounded font-black uppercase tracking-widest animate-pulse shadow-glow-red">
                            ⚠️ COMPENSATED SHOCK ALERT
                          </span>
                        )}
                      </div>

                      <div className="mt-2 text-sm text-zinc-300 leading-relaxed max-w-[1200px] font-sans font-medium">
                        {patient.triage_summary}
                      </div>

                      <div className="mt-3.5 flex flex-wrap items-center gap-6 text-[10px] text-zinc-550 font-bold uppercase tracking-wider">
                        <span>Record ID: <strong className="text-zinc-300 font-mono">{patient.id}</strong></span>
                        <span>Acquisition Source: <strong className="text-zinc-300 font-mono">{patient.video_path}</strong></span>
                        <span>Diagnosis Target: <strong className="text-indigo-400">{patient.primary_diagnosis}</strong></span>
                      </div>
                    </div>

                    <div className="flex flex-row md:flex-col items-center gap-3 self-start md:self-auto">
                      <div className={`border rounded-lg py-2 px-4 text-center min-w-[95px] ${getEsiClass(patient.esi_level)}`}>
                        <div className="text-[9px] uppercase font-black tracking-widest opacity-85">ESI Level</div>
                        <div className="text-2xl font-black font-mono leading-none mt-1">{patient.esi_level}</div>
                      </div>
                      <div className="bg-[#090e1e] border border-zinc-800 text-zinc-300 font-mono text-[10px] px-3 py-1.5 rounded text-center min-w-[95px] font-bold uppercase tracking-wider">
                        Score: {patient.priority_score}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

          </div>
        )}

        {/* VIEW 3: AGENT CREW PANEL */}
        {activeTab === 'crew' && (
          <div className="bg-[#090e1e]/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-xl shadow-xl flex flex-col min-h-[550px] relative overflow-hidden">
            
            <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-6">
              <div>
                <h2 className="text-base font-black text-white uppercase tracking-wider flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-purple-500 shadow-[0_0_8px_rgba(139,92,246,0.6)] animate-pulse"></span>
                  Multi-Agent Clinical Intelligence Crew
                </h2>
                <p className="text-xs text-zinc-450 uppercase tracking-wider font-bold mt-1">Execution logs of the 3-Agent Decoupled Triage pipeline</p>
              </div>

              <button 
                onClick={() => handleRunTriage()}
                disabled={isTriageRunning || metrics.status === 'DISCONNECTED'}
                className="bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-600 hover:to-indigo-700 disabled:from-zinc-900 disabled:to-zinc-900 disabled:text-zinc-650 disabled:cursor-not-allowed text-white font-extrabold text-sm py-3 px-6 rounded-xl transition-all shadow-glow-cyan hover:shadow-[0_0_20px_rgba(6,182,212,0.3)] flex items-center gap-2.5 uppercase tracking-wider"
              >
                {isTriageRunning ? (
                  <>
                    <span className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin"></span>
                    Negotiating...
                  </>
                ) : (
                  <>
                    ⚡ Kickoff Triage Crew
                  </>
                )}
              </button>
            </div>

            {/* Agent selecting buttons */}
            <div className="flex border-b border-zinc-800 mb-5 bg-[#030612]/30 rounded-t-xl overflow-hidden">
              <button 
                onClick={() => setActiveAgentTab('perception')}
                className={`flex-1 py-3.5 text-xs font-black uppercase tracking-widest transition-all ${
                  activeAgentTab === 'perception' ? 'text-cyan-400 border-b-2 border-cyan-500 bg-[#0e1326]/40 font-black' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Perception Agent (Vitals Capture)
              </button>
              <button 
                onClick={() => setActiveAgentTab('diagnostic')}
                className={`flex-1 py-3.5 text-xs font-black uppercase tracking-widest transition-all ${
                  activeAgentTab === 'diagnostic' ? 'text-amber-400 border-b-2 border-amber-500 bg-[#0e1326]/40 font-black' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Diagnostic Agent (Acuity Assessment)
              </button>
              <button 
                onClick={() => setActiveAgentTab('coordinator')}
                className={`flex-1 py-3.5 text-xs font-black uppercase tracking-widest transition-all ${
                  activeAgentTab === 'coordinator' ? 'text-indigo-400 border-b-2 border-indigo-500 bg-[#0e1326]/40 font-black' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Coordinator Agent (Queue Placement)
              </button>
            </div>

            {/* Main console screen */}
            <div className="bg-[#02040af0] border border-zinc-850 rounded-xl p-5 flex-1 overflow-y-auto max-h-[420px] font-mono text-sm leading-relaxed text-zinc-300 min-h-[300px] shadow-inner">
              {isTriageRunning && (
                <div className="h-full flex flex-col items-center justify-center text-zinc-500 py-16 gap-4">
                  <div className="w-10 h-10 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin shadow-glow-cyan"></div>
                  <div className="text-center font-sans">
                    <p className="text-sm font-black text-zinc-200 uppercase tracking-wider">Multi-Agent Negotiation Active</p>
                    <p className="text-xs text-zinc-500 mt-2 max-w-[340px] leading-relaxed uppercase tracking-widest font-bold">Consolidating rPPG bio-telemetry, analyzing shock state indicators, and prioritizing patients...</p>
                  </div>
                </div>
              )}

              {!isTriageRunning && !lastTriageResult && (
                <div className="h-full flex items-center justify-center text-zinc-500 text-center py-20 font-sans uppercase tracking-widest text-xs font-bold">
                  <div>
                    <p>Sensor pipeline idle.</p>
                    <p className="text-zinc-650 mt-1.5 text-[10px] uppercase font-mono">Upload a record or start live webcam and trigger Triage Crew.</p>
                  </div>
                </div>
              )}

              {!isTriageRunning && lastTriageResult && (
                <div>
                  {activeAgentTab === 'perception' && (
                    <div className="flex flex-col gap-3">
                      <div className="text-zinc-400 border-b border-zinc-850 pb-3 mb-2 font-sans font-bold text-xs uppercase text-cyan-400 tracking-wider flex items-center justify-between">
                        <span>Perception Analysis Log</span>
                        <span>[COMPILED]</span>
                      </div>
                      <div className="whitespace-pre-wrap font-mono leading-relaxed">
                        {`Patient Record: ${lastTriageResult.name}\nTimestamp: ${lastTriageResult.timestamp}\n\nACQUIRED PHYSIOLOGY:\n- Path: ${lastTriageResult.video_path}\n- Core Metrics Resolved:\n  • Heart Rate: ${metrics.bpm} BPM\n  • Respiration Rate: ${metrics.rr} breaths/min\n  • HRV: ${metrics.hrv.toFixed(1)} ms\n  • Stress Index: ${metrics.stress_index.toFixed(0)}\n  • Signal SNR: ${metrics.snr_db.toFixed(1)} dB\n\nDiagnostic buffer synchronized.`}
                      </div>
                    </div>
                  )}

                  {activeAgentTab === 'diagnostic' && (
                    <div className="flex flex-col gap-3">
                      <div className="text-zinc-400 border-b border-zinc-850 pb-3 mb-2 font-sans font-bold text-xs uppercase text-amber-400 tracking-wider flex items-center justify-between">
                        <span>Clinical Diagnostic Assessment</span>
                        <span>[COMPILED]</span>
                      </div>
                      <div className="whitespace-pre-wrap font-mono leading-relaxed">
                        {`DIAGNOSIS PATHOLOGY:\n- Recommended Index: ESI LEVEL ${lastTriageResult.esi_level}\n- Clinical Focus: ${lastTriageResult.primary_diagnosis}\n- Compensated Shock: ${lastTriageResult.is_shock ? "⚠️ SHOCK CRITERIA SATISFIED" : "STABLE / NO SHOCK"}\n\nESI CORRELATION LOGIC:\n- Cross-correlation analysis: HR (${metrics.bpm}) × RR (${metrics.rr})\n- Clinical documentation resolved.\n\nRaw decision trace:\n${lastTriageResult.agent_output.substring(0, 1500)}...`}
                      </div>
                    </div>
                  )}

                  {activeAgentTab === 'coordinator' && (
                    <div className="flex flex-col gap-4 font-sans p-2">
                      <div className="text-zinc-400 border-b border-zinc-850 pb-3 mb-2 font-sans font-bold text-xs uppercase text-indigo-400 tracking-wider flex items-center justify-between">
                        <span>Dynamic Queue Allocation</span>
                        <span>[COMPILED]</span>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-[#060813] border border-zinc-800 rounded-lg p-4 text-center shadow-glow-cyan">
                          <div className="text-[10px] text-zinc-500 font-extrabold uppercase tracking-wider">Acuity Level</div>
                          <div className="text-4xl font-black text-indigo-400 mt-2 font-mono">Level {lastTriageResult.esi_level}</div>
                        </div>
                        <div className="bg-[#060813] border border-zinc-800 rounded-lg p-4 text-center">
                          <div className="text-[10px] text-zinc-500 font-extrabold uppercase tracking-wider">Priority Rating</div>
                          <div className="text-4xl font-black text-cyan-400 mt-2 font-mono">{lastTriageResult.priority_score}/100</div>
                        </div>
                      </div>

                      <div className="bg-[#060813] border border-zinc-800 rounded-lg p-4">
                        <div className="text-[10px] text-zinc-500 font-extrabold uppercase tracking-wider mb-2 font-bold">Primary Clinical Indicator</div>
                        <div className="flex items-center gap-3">
                          <span className={`w-3.5 h-3.5 rounded-full ${lastTriageResult.is_shock ? 'bg-red-500 animate-ping shadow-[0_0_8px_#ef4444]' : 'bg-emerald-500'}`}></span>
                          <span className={`text-sm font-bold ${lastTriageResult.is_shock ? 'text-rose-400 font-black' : 'text-zinc-200'}`}>
                            {lastTriageResult.primary_diagnosis} {lastTriageResult.is_shock && "(Shock Indicator Active)"}
                          </span>
                        </div>
                      </div>

                      <div className="bg-[#02040a] border border-zinc-800 rounded-lg p-4">
                        <div className="text-[10px] text-zinc-500 font-extrabold uppercase tracking-wider mb-2 font-bold">Triage Summary & Rationale</div>
                        <p className="text-sm leading-relaxed text-zinc-200 font-medium">{lastTriageResult.triage_summary}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

          </div>
        )}

        </div>
      </main>

      {/* ── FLOATING BOTTOM-RIGHT ARIA CARTOON MASCOT ASSISTANT ── */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3 pointer-events-auto group">
        
        {/* Cartoon Speech Bubble saying "Hii!" — 100% hidden until cursor hovers over mascot */}
        {!isChatOpen && (
          <div 
            onClick={() => setIsChatOpen(true)}
            className="cursor-pointer bg-gradient-to-r from-indigo-600 via-purple-600 to-cyan-500 text-white text-xs font-extrabold px-4 py-2.5 rounded-2xl rounded-br-none shadow-2xl border border-indigo-400/40 flex items-center gap-2.5 transition-all duration-300 transform opacity-0 pointer-events-none translate-y-3 scale-90 group-hover:opacity-100 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:scale-100 animate-speech"
          >
            <span className="text-base animate-bounce">👋</span>
            <div className="flex flex-col">
              <span className="font-black tracking-wide text-xs">Hii! I'm ARIA 🤖</span>
              <span className="text-[9px] text-indigo-100 font-medium">Click to chat with me</span>
            </div>
          </div>
        )}

        {/* Floating Cartoon Mascot Badge Button */}
        <button
          onClick={() => setIsChatOpen(prev => !prev)}
          className={`relative p-1.5 rounded-full transition-all duration-300 shadow-2xl flex items-center justify-center ${
            isChatOpen 
              ? 'bg-rose-500 hover:bg-rose-600 scale-90 rotate-90' 
              : 'bg-gradient-to-tr from-indigo-500 via-purple-500 to-cyan-400 hover:scale-110 animate-pop-wave shadow-indigo-500/30'
          }`}
          title={isChatOpen ? "Close ARIA Chat" : "Open ARIA Chat"}
        >
          {isChatOpen ? (
            <div className="w-14 h-14 rounded-full flex items-center justify-center text-white text-xl font-bold">
              ✕
            </div>
          ) : (
            <div className="w-14 h-14 rounded-full overflow-hidden border-2 border-white/80 relative shadow-inner bg-slate-900">
              <img src="/aria_mascot.png" alt="ARIA Mascot" className="w-full h-full object-cover transition-transform" />
              <span className="absolute bottom-0.5 right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-400 border-2 border-slate-900 animate-pulse"></span>
            </div>
          )}
        </button>

        {/* Floating Chat Modal Window */}
        {isChatOpen && (
          <div className="fixed bottom-24 right-6 w-[430px] max-w-[calc(100vw-2.5rem)] h-[620px] max-h-[calc(100vh-7rem)] z-50 bg-[#09090b]/95 backdrop-blur-2xl border border-zinc-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col transition-all duration-300 animate-in slide-in-from-bottom-5">
            {/* ARIA Header */}
            <div className="bg-[#000000]/90 border-b border-zinc-800 p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full overflow-hidden border border-indigo-500/40 shrink-0 shadow-md">
                  <img src="/aria_mascot.png" alt="ARIA Mascot" className="w-full h-full object-cover" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-black text-white">ARIA</h3>
                    <span className="text-[8px] font-extrabold uppercase bg-indigo-950/80 text-indigo-400 border border-indigo-800/60 px-1.5 py-0.5 rounded">Adaptive Clinical AI</span>
                  </div>
                  <p className="text-[9px] text-zinc-400 font-medium">NVIDIA NIM OCR &amp; Diagnostic Consult</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* Voice Toggle */}
                <button
                  type="button"
                  onClick={() => {
                    setSpeechEnabled(prev => {
                      if (prev && typeof window !== 'undefined' && window.speechSynthesis) {
                        window.speechSynthesis.cancel();
                      }
                      return !prev;
                    });
                  }}
                  className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-md border transition-colors ${
                    speechEnabled 
                      ? 'bg-indigo-950/80 text-indigo-400 border-indigo-800/60 shadow-[0_0_8px_rgba(99,102,241,0.3)]' 
                      : 'bg-zinc-900/80 text-zinc-500 border-zinc-800 hover:text-zinc-300'
                  }`}
                  title={speechEnabled ? "Voice Output Active" : "Voice Output Muted"}
                >
                  {speechEnabled ? '🔊 On' : '🔇 Muted'}
                </button>

                {/* Close Button */}
                <button 
                  onClick={() => setIsChatOpen(false)}
                  className="text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-800 transition-colors text-xs font-bold"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Chat Message List */}
            <div className="flex-1 bg-[#000000] p-4 overflow-y-auto flex flex-col gap-3 font-sans text-xs">
              {chatHistory.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500 p-6">
                  <div className="w-16 h-16 rounded-full overflow-hidden border border-indigo-500/40 mb-3 shadow-lg bg-zinc-900">
                    <img src="/aria_mascot.png" alt="ARIA Mascot" className="w-full h-full object-cover" />
                  </div>
                  <p className="text-zinc-100 font-black text-sm">Hii! I'm ARIA 👋</p>
                  <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed max-w-[280px]">Ask clinical questions, interpret vital signs, or attach photos of lab reports for instant OCR analysis.</p>
                  <div className="mt-4 flex flex-wrap gap-1.5 justify-center max-w-[320px]">
                    {['Explain ESI Level 2', 'High stress index?', 'BRADYPNEA causes', 'Normal rPPG rate'].map(s => (
                      <button 
                        key={s} 
                        onClick={() => setChatInput(s)}
                        className="text-[9px] bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-indigo-300 px-2.5 py-1 rounded-lg font-bold uppercase transition-colors"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                chatHistory.map((msg, idx) => (
                  <div key={idx} className={`flex flex-col max-w-[88%] ${msg.role === 'user' ? 'self-end items-end' : 'self-start items-start'}`}>
                    <span className="text-[8px] text-zinc-500 font-extrabold uppercase tracking-widest mb-1">
                      {msg.role === 'user' ? 'Clinician' : 'ARIA'}
                    </span>
                    <div className={`p-3 rounded-2xl text-xs leading-relaxed font-medium whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-indigo-600 text-white rounded-tr-none shadow-md'
                        : 'bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-tl-none'
                    }`}>
                      {msg.image && (
                        <div className="mb-2 max-w-[180px] rounded-lg overflow-hidden border border-white/20">
                          <img src={msg.image} alt="Clinical doc" className="w-full h-auto object-cover" />
                        </div>
                      )}
                      {msg.content.replace(/^\[[a-z]{2}-[A-Z]{2}\]\s*/i, '').replace(/\*\*/g, '').replace(/\* /g, '• ')}
                    </div>
                  </div>
                ))
              )}
              {isChatLoading && (
                <div className="self-start flex items-center gap-2 text-[10px] text-cyan-400 font-bold uppercase font-mono animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping"></span>
                  ARIA is processing...
                </div>
              )}
              <div ref={chatEndRef}></div>
            </div>

            {/* Chat Input Form */}
            <form onSubmit={handleSendChatMessage} className="p-3 bg-[#09090b] border-t border-zinc-800 flex flex-col gap-2">
              {selectedImage && (
                <div className="flex items-center gap-2 p-2 bg-black border border-zinc-800 rounded-xl text-xs">
                  <img src={selectedImage} alt="Attachment" className="w-8 h-8 rounded object-cover" />
                  <span className="flex-1 truncate text-zinc-300 text-[10px] font-bold">Image Attachment Loaded</span>
                  <button type="button" onClick={() => setSelectedImage(null)} className="text-rose-400 text-xs font-bold px-1">✕</button>
                </div>
              )}
              <div className="flex items-center gap-2">
                <input type="file" accept="image/*" ref={imageInputRef} onChange={handleImageAttachment} className="hidden" />
                <button 
                  type="button" 
                  onClick={() => imageInputRef.current?.click()}
                  className="p-2.5 rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white transition-colors text-xs"
                  title="Attach Photo"
                >
                  📎
                </button>
                <button 
                  type="button" 
                  onClick={toggleRecording}
                  className={`p-2.5 rounded-xl border transition-colors text-xs ${
                    isRecording ? 'bg-rose-950 text-rose-400 border-rose-800 animate-pulse' : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-white'
                  }`}
                  title="Voice Input"
                >
                  🎙️
                </button>
                <input 
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask ARIA..."
                  className="flex-1 bg-black border border-zinc-800 rounded-xl text-xs px-3 py-2 text-white outline-none focus:border-cyan-500 transition-colors"
                />
                <button 
                  type="submit"
                  disabled={isChatLoading || (!chatInput.trim() && !selectedImage)}
                  className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold text-xs px-4 py-2 rounded-xl transition-colors uppercase tracking-wider"
                >
                  Send
                </button>
              </div>
            </form>
          </div>
        )}

      </div>

    </div>
  );
}
