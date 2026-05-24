incognito-chat/
├── backend/
│   ├── server.py
│   ├── requirements.txt
│   └── .env
├── frontend/
│   ├── public/
│   │   └── index.html
│   ├── src/
│   │   ├── index.js
│   │   ├── App.js
│   │   ├── App.css
│   │   ├── index.css
│   │   └── firebase.js
│   ├── package.json
│   ├── tailwind.config.js
│   └── postcss.config.js
└── README.md
🔧 BACKEND FILES
backend/server.py
from fastapi import FastAPI, APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional
import uuid
from datetime import datetime, timezone
import json

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI()
api_router = APIRouter(prefix="/api")

class PasswordVerify(BaseModel):
    password: str

class Message(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    sender: str
    content: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class MessageCreate(BaseModel):
    sender: str
    content: str

class UserStatus(BaseModel):
    model_config = ConfigDict(extra="ignore")
    user_id: str
    is_online: bool
    last_seen: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class WebRTCSignal(BaseModel):
    from_user: str
    to_user: str
    signal_type: str
    signal_data: dict

class ConnectionManager:
    def __init__(self):
        self.active_connections: dict = {}

    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        self.active_connections[user_id] = websocket
        await self.update_status(user_id, True)

    def disconnect(self, user_id: str):
        if user_id in self.active_connections:
            del self.active_connections[user_id]

    async def send_personal_message(self, message: str, user_id: str):
        if user_id in self.active_connections:
            await self.active_connections[user_id].send_text(message)

    async def broadcast(self, message: str):
        for connection in self.active_connections.values():
            await connection.send_text(message)
    
    async def update_status(self, user_id: str, is_online: bool):
        status_doc = {
            "user_id": user_id,
            "is_online": is_online,
            "last_seen": datetime.now(timezone.utc).isoformat()
        }
        await db.user_status.update_one(
            {"user_id": user_id},
            {"$set": status_doc},
            upsert=True
        )
        await self.broadcast(json.dumps({"type": "status_update", "data": status_doc}))

manager = ConnectionManager()

@api_router.post("/verify-password")
async def verify_password(data: PasswordVerify):
    correct_password = "jaan"
    if data.password == correct_password:
        return {"success": True, "message": "Password correct"}
    return {"success": False, "message": "Invalid password"}

@api_router.post("/messages", response_model=Message)
async def create_message(input: MessageCreate):
    message = Message(**input.model_dump())
    doc = message.model_dump()
    doc['timestamp'] = doc['timestamp'].isoformat()
    result = await db.messages.insert_one(doc)
    doc.pop('_id', None)
    
    await manager.broadcast(json.dumps({
        "type": "new_message",
        "data": doc
    }))
    
    return message

@api_router.get("/messages", response_model=List[Message])
async def get_messages(limit: int = 100):
    messages = await db.messages.find({}, {"_id": 0}).sort("timestamp", 1).to_list(limit)
    for msg in messages:
        if isinstance(msg['timestamp'], str):
            msg['timestamp'] = datetime.fromisoformat(msg['timestamp'])
    return messages

@api_router.delete("/messages")
async def delete_all_messages():
    result = await db.messages.delete_many({})
    await manager.broadcast(json.dumps({"type": "messages_cleared"}))
    return {"deleted_count": result.deleted_count}

@api_router.get("/users/{user_id}/status")
async def get_user_status(user_id: str):
    status = await db.user_status.find_one({"user_id": user_id}, {"_id": 0})
    if not status:
        return {"user_id": user_id, "is_online": False, "last_seen": None}
    return status

@api_router.post("/users/{user_id}/status")
async def update_user_status(user_id: str, is_online: bool):
    await manager.update_status(user_id, is_online)
    return {"success": True}

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    await manager.connect(websocket, user_id)
    try:
        while True:
            data = await websocket.receive_text()
            message_data = json.loads(data)
            
            if message_data.get("type") == "webrtc_signal":
                target_user = message_data.get("to_user")
                if target_user in manager.active_connections:
                    await manager.send_personal_message(data, target_user)
            elif message_data.get("type") == "message":
                await manager.broadcast(data)
    except WebSocketDisconnect:
        manager.disconnect(user_id)
        await manager.update_status(user_id, False)

app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
backend/requirements.txt
fastapi==0.110.1
uvicorn==0.25.0
python-dotenv>=1.0.1
motor==3.3.1
pydantic>=2.6.4
firebase-admin==7.4.0
backend/.env
MONGO_URL=mongodb://localhost:27017
DB_NAME=incognito_chat
CORS_ORIGINS=*
🎨 FRONTEND FILES
frontend/public/index.html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="%PUBLIC_URL%/favicon.ico" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#000000" />
    <meta name="description" content="Calculator App" />
    <link rel="apple-touch-icon" href="%PUBLIC_URL%/logo192.png" />
    <link rel="manifest" href="%PUBLIC_URL%/manifest.json" />
    <title>Calculator</title>
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this app.</noscript>
    <div id="root"></div>
  </body>
</html>
frontend/src/index.js
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
frontend/src/App.js
import { useState, useEffect, useRef } from 'react';
import './App.css';
import axios from 'axios';
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff, Send, Lock } from 'lucide-react';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'http://localhost:8001';
const API = `${BACKEND_URL}/api`;

function App() {
  const [screen, setScreen] = useState('password');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState(false);
  const [calcDisplay, setCalcDisplay] = useState('0');
  const [calcPrevValue, setCalcPrevValue] = useState(null);
  const [calcOperation, setCalcOperation] = useState(null);
  const [calcWaitingForOperand, setCalcWaitingForOperand] = useState(false);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [isOnline, setIsOnline] = useState(false);
  const [callState, setCallState] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const ws = useRef(null);
  const messagesEndRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnection = useRef(null);
  const localStream = useRef(null);

  const currentUser = 'admin';

  useEffect(() => {
    if (screen === 'chat') {
      connectWebSocket();
      loadMessages();
      requestNotificationPermission();
      checkUserStatus();
    }
    return () => {
      if (ws.current) {
        ws.current.close();
      }
    };
  }, [screen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const connectWebSocket = () => {
    const wsUrl = BACKEND_URL.replace('https://', 'wss://').replace('http://', 'ws://');
    ws.current = new WebSocket(`${wsUrl}/ws/${currentUser}`);

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'new_message') {
        setMessages((prev) => [...prev, data.data]);
      } else if (data.type === 'messages_cleared') {
        setMessages([]);
      } else if (data.type === 'status_update') {
        if (data.data.user_id === 'user' && data.data.is_online) {
          setIsOnline(true);
          showNotification('User is online!');
        } else if (data.data.user_id === 'user') {
          setIsOnline(false);
        }
      } else if (data.type === 'webrtc_signal') {
        handleWebRTCSignal(data);
      }
    };
  };

  const loadMessages = async () => {
    try {
      const response = await axios.get(`${API}/messages`);
      setMessages(response.data);
    } catch (error) {
      console.error('Error loading messages:', error);
    }
  };

  const requestNotificationPermission = async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  };

  const showNotification = (message) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Incognito Chat', { body: message, icon: '/favicon.ico' });
    }
  };

  const checkUserStatus = async () => {
    try {
      const response = await axios.get(`${API}/users/user/status`);
      setIsOnline(response.data.is_online);
    } catch (error) {
      console.error('Error checking status:', error);
    }
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    try {
      const response = await axios.post(`${API}/verify-password`, { password });
      if (response.data.success) {
        setScreen('calculator');
        setPasswordError(false);
      } else {
        setPasswordError(true);
        setPassword('');
        setTimeout(() => setPasswordError(false), 500);
      }
    } catch (error) {
      setPasswordError(true);
      setPassword('');
      setTimeout(() => setPasswordError(false), 500);
    }
  };

  const inputDigit = (digit) => {
    if (calcWaitingForOperand) {
      setCalcDisplay(String(digit));
      setCalcWaitingForOperand(false);
    } else {
      setCalcDisplay(calcDisplay === '0' ? String(digit) : calcDisplay + digit);
    }
  };

  const inputDecimal = () => {
    if (calcWaitingForOperand) {
      setCalcDisplay('0.');
      setCalcWaitingForOperand(false);
    } else if (calcDisplay.indexOf('.') === -1) {
      setCalcDisplay(calcDisplay + '.');
    }
  };

  const clear = () => {
    setCalcDisplay('0');
    setCalcPrevValue(null);
    setCalcOperation(null);
    setCalcWaitingForOperand(false);
  };

  const performOperation = (nextOperation) => {
    const inputValue = parseFloat(calcDisplay);

    if (calcPrevValue === null) {
      setCalcPrevValue(inputValue);
    } else if (calcOperation) {
      const currentValue = calcPrevValue || 0;
      const newValue = calculate(currentValue, inputValue, calcOperation);
      setCalcDisplay(String(newValue));
      setCalcPrevValue(newValue);
    }

    setCalcWaitingForOperand(true);
    setCalcOperation(nextOperation);
  };

  const calculate = (firstValue, secondValue, operation) => {
    switch (operation) {
      case '+':
        return firstValue + secondValue;
      case '-':
        return firstValue - secondValue;
      case '×':
        return firstValue * secondValue;
      case '÷':
        return firstValue / secondValue;
      default:
        return secondValue;
    }
  };

  const handleEquals = () => {
    const inputValue = parseFloat(calcDisplay);

    if (calcDisplay === '143' || (calcPrevValue === 143 && calcOperation === '+' && inputValue === 0)) {
      setScreen('chat');
      return;
    }

    if (calcPrevValue !== null && calcOperation) {
      const newValue = calculate(calcPrevValue, inputValue, calcOperation);
      setCalcDisplay(String(newValue));
      setCalcPrevValue(null);
      setCalcOperation(null);
      setCalcWaitingForOperand(false);
    }
  };

  const sendMessage = async () => {
    if (!messageInput.trim()) return;
    try {
      const response = await axios.post(`${API}/messages`, {
        sender: currentUser,
        content: messageInput,
      });
      setMessages((prev) => [...prev, response.data]);
      setMessageInput('');
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  const handleDoubleClick = async () => {
    try {
      await axios.delete(`${API}/messages`);
      setMessages([]);
      setScreen('calculator');
    } catch (error) {
      console.error('Error clearing messages:', error);
    }
  };

  const startCall = async (isVideoCall) => {
    try {
      const constraints = {
        audio: true,
        video: isVideoCall,
      };
      localStream.current = await navigator.mediaDevices.getUserMedia(constraints);
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream.current;
      }

      setCallState(isVideoCall ? 'video' : 'audio');
      setupPeerConnection();
    } catch (error) {
      console.error('Error starting call:', error);
    }
  };

  const setupPeerConnection = async () => {
    const configuration = {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    };

    peerConnection.current = new RTCPeerConnection(configuration);

    localStream.current.getTracks().forEach((track) => {
      peerConnection.current.addTrack(track, localStream.current);
    });

    peerConnection.current.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    peerConnection.current.onicecandidate = (event) => {
      if (event.candidate && ws.current) {
        ws.current.send(
          JSON.stringify({
            type: 'webrtc_signal',
            to_user: 'user',
            signal_type: 'ice-candidate',
            signal_data: event.candidate,
          })
        );
      }
    };

    const offer = await peerConnection.current.createOffer();
    await peerConnection.current.setLocalDescription(offer);

    if (ws.current) {
      ws.current.send(
        JSON.stringify({
          type: 'webrtc_signal',
          to_user: 'user',
          signal_type: 'offer',
          signal_data: offer,
        })
      );
    }
  };

  const handleWebRTCSignal = async (data) => {
    if (!peerConnection.current) return;

    if (data.signal_type === 'answer') {
      await peerConnection.current.setRemoteDescription(
        new RTCSessionDescription(data.signal_data)
      );
    } else if (data.signal_type === 'ice-candidate') {
      await peerConnection.current.addIceCandidate(
        new RTCIceCandidate(data.signal_data)
      );
    }
  };

  const endCall = () => {
    if (localStream.current) {
      localStream.current.getTracks().forEach((track) => track.stop());
      localStream.current = null;
    }
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setCallState(null);
    setIsMuted(false);
    setIsVideoOn(true);
  };

  const toggleMute = () => {
    if (localStream.current) {
      const audioTrack = localStream.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleVideo = () => {
    if (localStream.current) {
      const videoTrack = localStream.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoOn(videoTrack.enabled);
      }
    }
  };

  if (screen === 'password') {
    return (
      <div className="h-screen w-full bg-black flex items-center justify-center">
        <form onSubmit={handlePasswordSubmit} className="flex flex-col items-center gap-6">
          <Lock className="w-12 h-12 text-neutral-600" />
          <input
            data-testid="password-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`bg-transparent border-b text-white text-center text-xl px-4 py-2 focus:outline-none transition-all ${
              passwordError
                ? 'border-red-500 animate-shake'
                : 'border-neutral-800 focus:border-neutral-600'
            }`}
            placeholder="Enter password"
            autoFocus
          />
        </form>
      </div>
    );
  }

  if (screen === 'calculator') {
    return (
      <div className="h-screen w-full bg-black flex flex-col justify-end p-4">
        <div
          data-testid="calc-display"
          className="text-white text-7xl font-light text-right mb-4 px-4 break-all"
        >
          {calcDisplay}
        </div>
        <div className="grid grid-cols-4 gap-3">
          <button
            data-testid="calc-btn-clear"
            onClick={clear}
            className="bg-neutral-600 text-black text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            AC
          </button>
          <button
            onClick={() => {
              setCalcDisplay(String(parseFloat(calcDisplay) * -1));
            }}
            className="bg-neutral-600 text-black text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            ±
          </button>
          <button
            onClick={() => {
              setCalcDisplay(String(parseFloat(calcDisplay) / 100));
            }}
            className="bg-neutral-600 text-black text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            %
          </button>
          <button
            data-testid="calc-btn-divide"
            onClick={() => performOperation('÷')}
            className="bg-orange-500 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            ÷
          </button>

          <button
            data-testid="calc-btn-7"
            onClick={() => inputDigit(7)}
            className="bg-neutral-800 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            7
          </button>
          <button
            data-testid="calc-btn-8"
            onClick={() => inputDigit(8)}
            className="bg-neutral-800 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            8
          </button>
          <button
            data-testid="calc-btn-9"
            onClick={() => inputDigit(9)}
            className="bg-neutral-800 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            9
          </button>
          <button
            data-testid="calc-btn-multiply"
            onClick={() => performOperation('×')}
            className="bg-orange-500 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            ×
          </button>

          <button
            data-testid="calc-btn-4"
            onClick={() => inputDigit(4)}
            className="bg-neutral-800 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            4
          </button>
          <button
            data-testid="calc-btn-5"
            onClick={() => inputDigit(5)}
            className="bg-neutral-800 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            5
          </button>
          <button
            data-testid="calc-btn-6"
            onClick={() => inputDigit(6)}
            className="bg-neutral-800 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            6
          </button>
          <button
            data-testid="calc-btn-subtract"
            onClick={() => performOperation('-')}
            className="bg-orange-500 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            −
          </button>

          <button
            data-testid="calc-btn-1"
            onClick={() => inputDigit(1)}
            className="bg-neutral-800 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            1
          </button>
          <button
            data-testid="calc-btn-2"
            onClick={() => inputDigit(2)}
            className="bg-neutral-800 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            2
          </button>
          <button
            data-testid="calc-btn-3"
            onClick={() => inputDigit(3)}
            className="bg-neutral-800 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            3
          </button>
          <button
            data-testid="calc-btn-add"
            onClick={() => performOperation('+')}
            className="bg-orange-500 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            +
          </button>

          <button
            data-testid="calc-btn-0"
            onClick={() => inputDigit(0)}
            className="bg-neutral-800 text-white text-3xl font-light rounded-full h-20 col-span-2 active:scale-95 transition-transform"
          >
            0
          </button>
          <button
            data-testid="calc-btn-decimal"
            onClick={inputDecimal}
            className="bg-neutral-800 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            .
          </button>
          <button
            data-testid="calc-btn-equals"
            onClick={handleEquals}
            className="bg-orange-500 text-white text-3xl font-light rounded-full h-20 active:scale-95 transition-transform"
          >
            =
          </button>
        </div>
      </div>
    );
  }

  if (screen === 'chat' && callState) {
    return (
      <div className="h-screen w-full bg-black relative">
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="w-full h-full object-cover"
        />
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute top-4 right-4 w-32 h-40 object-cover rounded-lg border-2 border-white/30"
        />
        <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 flex gap-4 bg-black/40 backdrop-blur-xl px-6 py-4 rounded-full">
          <button
            data-testid="call-mute-btn"
            onClick={toggleMute}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
              isMuted ? 'bg-red-500' : 'bg-white/20'
            }`}
          >
            {isMuted ? <MicOff className="w-6 h-6 text-white" /> : <Mic className="w-6 h-6 text-white" />}
          </button>
          {callState === 'video' && (
            <button
              data-testid="call-video-btn"
              onClick={toggleVideo}
              className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
                !isVideoOn ? 'bg-red-500' : 'bg-white/20'
              }`}
            >
              {isVideoOn ? <Video className="w-6 h-6 text-white" /> : <VideoOff className="w-6 h-6 text-white" />}
            </button>
          )}
          <button
            data-testid="call-end-btn"
            onClick={endCall}
            className="w-14 h-14 rounded-full bg-red-500 flex items-center justify-center"
          >
            <PhoneOff className="w-6 h-6 text-white" />
          </button>
        </div>
      </div>
    );
  }

  if (screen === 'chat') {
    return (
      <div
        data-testid="chat-interface"
        className="h-screen w-full bg-black flex flex-col max-w-md mx-auto"
        onDoubleClick={handleDoubleClick}
      >
        <div className="bg-neutral-900 p-4 flex items-center justify-between border-b border-neutral-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600"></div>
            <div>
              <div className="text-white font-medium">User</div>
              <div className="text-xs text-neutral-400">
                {isOnline ? (
                  <span data-testid="online-status" className="flex items-center gap-1">
                    <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                    Online
                  </span>
                ) : (
                  'Offline'
                )}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              data-testid="audio-call-btn"
              onClick={() => startCall(false)}
              className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center hover:bg-blue-700 transition-colors"
            >
              <Phone className="w-5 h-5 text-white" />
            </button>
            <button
              data-testid="video-call-btn"
              onClick={() => startCall(true)}
              className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center hover:bg-blue-700 transition-colors"
            >
              <Video className="w-5 h-5 text-white" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg, idx) => (
            <div
              key={idx}
              data-testid={`message-${idx}`}
              className={`flex ${msg.sender === currentUser ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[70%] px-4 py-2 rounded-2xl ${
                  msg.sender === currentUser
                    ? 'bg-blue-600 text-white rounded-br-sm'
                    : 'bg-neutral-800 text-white rounded-bl-sm'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 bg-neutral-900 border-t border-neutral-800">
          <div className="flex gap-2">
            <input
              data-testid="message-input"
              type="text"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
              placeholder="Type a message..."
              className="flex-1 bg-neutral-800 text-white px-4 py-3 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <button
              data-testid="send-message-btn"
              onClick={sendMessage}
              className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center hover:bg-blue-700 transition-colors"
            >
              <Send className="w-5 h-5 text-white" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  ret
}
