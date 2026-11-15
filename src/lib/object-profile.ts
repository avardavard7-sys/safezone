'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { BusinessType, FeatureInfo, ObjectProfile } from '@/lib/business';

let cached: ObjectProfile | null = null;
const listeners = new Set<(p: ObjectProfile | null) => void>();
const publish = (p: ObjectProfile | null) => { cached = p; listeners.forEach(l => l(p)); };

export async function loadObjectProfile(): Promise<ObjectProfile | null> {
  const { data, error } = await createClient().rpc('my_object_profile');
  if (error) throw error;
  publish((data as ObjectProfile) || null);
  return cached;
}

export function useObjectProfile() {
  const [profile, setProfile] = useState<ObjectProfile | null>(cached);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    listeners.add(setProfile);
    if (!cached) loadObjectProfile().catch(() => {}).finally(() => setLoading(false));
    return () => { listeners.delete(setProfile); };
  }, []);

  const has = useCallback((feature?: string) => !feature || Boolean(profile?.features?.[feature]), [profile]);

  return { profile, loading, has };
}

export async function setBusinessType(t: BusinessType) {
  const { data, error } = await createClient().rpc('set_business_type', { t });
  if (error) throw error;
  publish(data as ObjectProfile);
}

export async function setFeature(featureKey: string, enabled: boolean, ackText?: string) {
  const { data, error } = await createClient().rpc('set_object_feature', {
    feature_key: featureKey,
    enabled,
    ack_text: ackText ?? null,
  });
  if (error) throw error;
  publish(data as ObjectProfile);
}

export async function loadFeatureCatalog(): Promise<FeatureInfo[]> {
  const { data, error } = await createClient().from('feature_catalog').select('*').order('sort');
  if (error) throw error;
  return (data as FeatureInfo[]) || [];
}
