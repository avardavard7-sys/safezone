export interface Mall {
  id: string; name: string; address: string; city: string;
  contact_phone?: string; contact_email?: string;
  cameras_count?: number; tenants_count?: number;
  work_start?: string; work_end?: string;
  is_approved: boolean; created_at: string;
}

export interface Camera {
  id: string; mall_id: string; zone_id?: string; name: string;
  ip_address: string; port: number; username: string; password?: string;
  rtsp_path: string; status: 'online' | 'offline' | 'error';
  floor: number; is_active: boolean;
  last_frame_base64?: string; last_frame_at?: string;
  created_at: string;
}

export interface Event {
  id: string; mall_id: string; camera_id?: string; camera_name?: string;
  type: 'theft' | 'fight' | 'crowd' | 'fire' | 'smoking' | 'child_lost' | 'escalator' | 'violation' | 'suspicious' | 'fall' | 'access' | 'vandalism';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string; zone?: string; floor?: number;
  image_url?: string; video_url?: string;
  status: 'new' | 'reviewing' | 'resolved' | 'false_alarm';
  created_at: string;
}

export interface Tenant {
  id: string; mall_id: string; name: string; shop_number?: string;
  floor: number; zone?: string; category: string;
  contact_person?: string; phone?: string; email?: string;
  work_start: string; work_end: string;
  violations_count: number; total_fines: number;
  is_active: boolean; created_at: string;
}

export interface Violation {
  id: string; mall_id: string; tenant_id?: string; tenant_name: string;
  event_id?: string; type: string; description: string;
  evidence_url?: string; fine_mrp: number; fine_amount: number;
  act_number: string; status: 'pending' | 'confirmed' | 'paid' | 'disputed' | 'cancelled';
  created_at: string;
}

export interface Zone {
  id: string; mall_id: string; name: string; floor: number;
  type: 'entrance' | 'corridor' | 'parking' | 'food_court' | 'escalator' | 'loading' | 'restroom' | 'kids' | 'cinema' | 'shop';
  max_capacity: number; current_visitors: number;
  cameras_count: number; created_at: string;
}

export interface Profile {
  id: string; username: string; full_name?: string;
  role: 'admin' | 'security' | 'manager' | 'developer';
  mall_id?: string; phone?: string; telegram_chat_id?: string;
  is_approved: boolean; created_at: string;
}
