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
