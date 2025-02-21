import React, { useState, useRef, useEffect } from 'react';
import { Mic, MicOff, Send, Settings, Loader2 } from 'lucide-react';
import { cn } from './lib/utils';

interface Message {
  id: string;
  type: 'user' | 'assistant' | 'transcript';
  content: string;
  timestamp: Date;
}

interface WebRTCState {
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  audioContext: AudioContext | null;
  processor: ScriptProcessorNode | null;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [inputMessage, setInputMessage] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  const chatRef = useRef<HTMLDivElement>(null);
  const webRTCRef = useRef<WebRTCState>({
    pc: null,
    dc: null,
    audioContext: null,
    processor: null
  });

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  const cleanupConnection = () => {
    const { pc, dc, processor, audioContext } = webRTCRef.current;
    
    if (processor) {
      processor.disconnect();
      webRTCRef.current.processor = null;
    }

    if (audioContext) {
      audioContext.close();
      webRTCRef.current.audioContext = null;
    }

    if (dc) {
      dc.close();
      webRTCRef.current.dc = null;
    }

    if (pc) {
      pc.close();
      webRTCRef.current.pc = null;
    }

    setIsConnected(false);
    setIsConnecting(false);
    setIsRecording(false);
  };

  const connect = async () => {
    if (!apiKey) {
      setShowSettings(true);
      return;
    }

    // Clean up any existing connection
    cleanupConnection();
    setIsConnecting(true);

    try {
      const pc = new RTCPeerConnection();
      const dc = pc.createDataChannel("oai-events");
      webRTCRef.current.pc = pc;
      webRTCRef.current.dc = dc;

      pc.ontrack = (e) => {
        const audio = document.getElementById('remote-audio') as HTMLAudioElement;
        if (audio && audio.srcObject !== e.streams[0]) {
          audio.srcObject = e.streams[0];
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(stream.getTracks()[0]);

      dc.onopen = () => {
        setIsConnected(true);
        setIsConnecting(false);
        initializeSession();
      };

      dc.onmessage = (e) => handleMessage(JSON.parse(e.data));
      dc.onclose = () => {
        setIsConnected(false);
        setIsConnecting(false);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const response = await fetch(
        "https://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17",
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/sdp"
          }
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const answerSdp = await response.text();
      await pc.setRemoteDescription({
        type: "answer",
        sdp: answerSdp
      });

    } catch (error) {
      console.error('Connection error:', error);
      cleanupConnection();
      alert('Failed to connect. Please check your API key and try again.');
    }
  };

  const initializeSession = () => {
    const { dc } = webRTCRef.current;
    if (!dc || dc.readyState !== 'open') return;

    try {
      dc.send(JSON.stringify({
        type: "session.update",
        session: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 200
          },
          input_audio_transcription: {
            model: "whisper-1"
          },
          voice: "alloy",
          instructions: "Please respond entirely in English only.",
          modalities: ["text", "audio"],
          temperature: 0.8,
        }
      }));

      dc.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["text", "audio"],
          instructions: "Please assist the user."
        }
      }));
    } catch (error) {
      console.error('Error initializing session:', error);
      cleanupConnection();
    }
  };

  const handleMessage = (event: any) => {
    switch (event.type) {
      case 'response.text.delta':
        setMessages(prev => {
          const lastMessage = prev[prev.length - 1];
          if (lastMessage?.type === 'assistant') {
            return [
              ...prev.slice(0, -1),
              { ...lastMessage, content: lastMessage.content + event.delta.text }
            ];
          }
          return [
            ...prev,
            {
              id: Math.random().toString(),
              type: 'assistant',
              content: event.delta.text,
              timestamp: new Date()
            }
          ];
        });
        setIsTyping(true);
        break;

      case 'response.text.end':
        setIsTyping(false);
        break;

      case 'conversation.item.input_audio_transcription.delta':
        setMessages(prev => [
          ...prev,
          {
            id: event.item_id,
            type: 'transcript',
            content: event.delta,
            timestamp: new Date()
          }
        ]);
        break;

      case 'error':
        console.error('API Error:', event);
        alert('An error occurred. Please try again.');
        cleanupConnection();
        break;
    }
  };

  const startRecording = async () => {
    if (!isConnected) {
      await connect();
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (e) => {
        const { dc } = webRTCRef.current;
        if (dc?.readyState === 'open') {
          const inputData = e.inputBuffer.getChannelData(0);
          const int16Data = new Int16Array(inputData.length);
          
          for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i]));
            int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          try {
            dc.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: Array.from(int16Data)
            }));
          } catch (error) {
            console.error('Error sending audio data:', error);
            stopRecording();
          }
        }
      };

      webRTCRef.current.audioContext = audioContext;
      webRTCRef.current.processor = processor;
      setIsRecording(true);

    } catch (error) {
      console.error('Recording error:', error);
      alert('Failed to start recording. Please check your microphone permissions.');
      cleanupConnection();
    }
  };

  const stopRecording = () => {
    const { dc } = webRTCRef.current;

    if (dc?.readyState === 'open') {
      try {
        dc.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        dc.send(JSON.stringify({ type: 'response.create' }));
      } catch (error) {
        console.error('Error stopping recording:', error);
      }
    }

    cleanupConnection();
  };

  const sendMessage = async () => {
    const message = inputMessage.trim();
    if (!message) return;

    if (!isConnected) {
      try {
        await connect();
      } catch (error) {
        console.error('Connection error:', error);
        return;
      }
    }

    const { dc } = webRTCRef.current;
    if (!dc || dc.readyState !== 'open') {
      alert('Not connected. Please try again.');
      return;
    }

    try {
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(),
          type: 'user',
          content: message,
          timestamp: new Date()
        }
      ]);

      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: message
          }]
        }
      }));

      dc.send(JSON.stringify({
        type: "response.create"
      }));

      setInputMessage('');
    } catch (error) {
      console.error('Error sending message:', error);
      alert('Failed to send message. Please try again.');
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-800">OpenAI Realtime Chat</h1>
        <div className="flex items-center gap-3">
          <div className={cn(
            "h-2 w-2 rounded-full",
            isConnected ? "bg-green-500" : "bg-red-500"
          )} />
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <Settings className="w-5 h-5 text-gray-600" />
          </button>
        </div>
      </header>

      {/* Chat Area */}
      <div 
        ref={chatRef}
        className="flex-1 overflow-y-auto p-4 space-y-4"
      >
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "max-w-[80%] rounded-lg p-3",
              message.type === 'user' && "ml-auto bg-blue-500 text-white",
              message.type === 'assistant' && "bg-white border border-gray-200",
              message.type === 'transcript' && "italic text-gray-500 text-sm"
            )}
          >
            {message.content}
          </div>
        ))}
        {isTyping && (
          <div className="flex gap-2 items-center text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            Assistant is typing...
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="bg-white border-t border-gray-200 p-4">
        <div className="flex items-center gap-2 max-w-4xl mx-auto">
          <button
            onClick={isRecording ? stopRecording : startRecording}
            disabled={isConnecting}
            className={cn(
              "p-3 rounded-full transition-colors",
              isRecording 
                ? "bg-red-500 hover:bg-red-600 text-white"
                : "bg-gray-100 hover:bg-gray-200 text-gray-700",
              isConnecting && "opacity-50 cursor-not-allowed"
            )}
          >
            {isConnecting ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : isRecording ? (
              <MicOff className="w-5 h-5" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>
          <input
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
            placeholder="Type a message..."
            className="flex-1 p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={sendMessage}
            disabled={!inputMessage.trim() || isConnecting}
            className="p-3 bg-blue-500 text-white rounded-full hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full">
            <h2 className="text-xl font-semibold mb-4">API Settings</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  OpenAI API Key
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full p-2 border border-gray-300 rounded-md"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowSettings(false)}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setShowSettings(false);
                    connect();
                  }}
                  className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
                >
                  Save & Connect
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <audio id="remote-audio" autoPlay />
    </div>
  );
}