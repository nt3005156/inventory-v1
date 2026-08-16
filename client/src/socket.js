import {io} from 'socket.io-client';

export function socketOrigin() {
  const configured = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL;
  if (configured && String(configured).startsWith('http')) return String(configured).replace(/\/api\/?$/, '');
  return typeof window !== 'undefined' ? window.location.origin : undefined;
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
