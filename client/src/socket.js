import {io} from 'socket.io-client';

export function socketOrigin() {
  const api = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
  if (String(api).startsWith('http')) return String(api).replace(/\/api\/?$/, '');
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000';
}

export function connectBranchSocket(token, branchId) {
  return io(socketOrigin(), {
    auth: {token, ...(branchId ? {branch: branchId} : {})},
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000
  });
}
