import { defineStore } from "pinia";
import { ref, watch } from "vue";

export interface AppSettings {
  pageSize: number;
}

const STORAGE_KEY = "douyin-index-settings";

const defaultSettings: AppSettings = {
  pageSize: 100,
};

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw);
    return { ...defaultSettings, ...parsed };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export const useSettingsStore = defineStore("settings", () => {
  const loaded = loadSettings();
  const pageSize = ref(loaded.pageSize);

  function update(patch: Partial<AppSettings>): void {
    if (patch.pageSize !== undefined) pageSize.value = patch.pageSize;
  }

  function reset(): void {
    pageSize.value = defaultSettings.pageSize;
  }

  // 自动持久化
  watch(
    [pageSize],
    () => {
      saveSettings({
        pageSize: pageSize.value,
      });
    },
    { deep: true }
  );

  return {
    pageSize,
    update,
    reset,
  };
});
