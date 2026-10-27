export type BusinessType = 'shop' | 'mall' | 'cafe' | 'production';
export type FeatureCategory = 'visitors' | 'danger' | 'theft' | 'security' | 'service';

export const BUSINESS_TYPES: { key: BusinessType; label: string; hint: string }[] = [
  { key: 'shop', label: 'Магазин', hint: 'Посетители, кражи с полки и на кассе, опасные ситуации' },
  { key: 'mall', label: 'Торговый центр', hint: 'Арендаторы и нарушения, скопления, безопасность' },
  { key: 'cafe', label: 'Кафе', hint: 'Регламент, зоны сервиса, касса' },
  { key: 'production', label: 'Производство', hint: 'Запретные зоны, падения, пожар' },
];

export const CATEGORY_LABEL: Record<FeatureCategory, string> = {
  visitors: 'Посетители',
  danger: 'Опасность',
  theft: 'Кражи',
  security: 'Охрана',
  service: 'Сервис',
};

export type FeatureInfo = {
  key: string;
  label: string;
  description: string;
  category: FeatureCategory;
  defaults: BusinessType[];
  sensitive: boolean;
  status: 'ready' | 'building';
  sort: number;
};

export type ObjectProfile = {
  mall_id: string;
  name: string;
  business_type: BusinessType;
  features: Record<string, boolean>;
  can_manage: boolean;
  acks: Record<string, string>;
};

export const BLACKLIST_ACK =
  'Подтверждаю: правовое основание для обработки изображений лиц из списка согласовано с юристом, ' +
  'посетители уведомлены о видеонаблюдении, ответственность за ведение списка несёт владелец объекта.';
