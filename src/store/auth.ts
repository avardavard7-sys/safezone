import { create } from 'zustand';
import { Profile, Mall } from '@/types';

interface AuthState {
  user: any | null;
  profile: Profile | null;
  mall: Mall | null;
  setUser: (u: any) => void;
  setProfile: (p: Profile | null) => void;
  setMall: (m: Mall | null) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null, profile: null, mall: null,
  setUser: (user) => set({ user }),
  setProfile: (profile) => set({ profile }),
  setMall: (mall) => set({ mall }),
  logout: () => set({ user: null, profile: null, mall: null }),
}));
