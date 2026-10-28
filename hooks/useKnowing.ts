"use client";
/**
 * App state for Knowing: profile, taught items, chat history and the optional
 * password. Loads from localStorage once on mount and saves on every change.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getHealth } from "@/lib/api-client";
import { EMPTY_PROFILE, STORAGE_KEYS } from "@/lib/constants";
import {
  createBackup,
  loadChat,
  loadItems,
  loadProfile,
  mergeItems,
  parseBackup,
  readJson,
  saveChat,
  saveItems,
  saveProfile,
  writeJson,
} from "@/lib/storage";
import type { ChatTurn, HealthResponse, KnowledgeItem, Profile } from "@/lib/types";

export interface KnowingState {
  /** False until localStorage has been read, to avoid a flash of empty UI. */
  ready: boolean;
  health: HealthResponse | null;
  profile: Profile;
  items: KnowledgeItem[];
  chat: ChatTurn[];
  password: string;
  setProfile: (profile: Profile) => boolean;
  addItem: (item: KnowledgeItem) => boolean;
  updateItem: (id: string, patch: Partial<KnowledgeItem>) => void;
  deleteItem: (id: string) => void;
  setChat: (chat: ChatTurn[]) => void;
  setPassword: (password: string) => void;
  exportBackup: () => string;
  importBackup: (raw: string) => { items: number };
}

export function useKnowing(): KnowingState {
  const [ready, setReady] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [profile, setProfileState] = useState<Profile>(EMPTY_PROFILE);
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [chat, setChatState] = useState<ChatTurn[]>([]);
  const [password, setPasswordState] = useState("");
  // Mirror of `items` so callbacks can save synchronously and report quota errors.
  const itemsRef = useRef<KnowledgeItem[]>([]);

  /** Replace the item list in state and storage. Returns false if storage is full. */
  const commitItems = useCallback((next: KnowledgeItem[]) => {
    itemsRef.current = next;
    setItems(next);
    return saveItems(next);
  }, []);

  useEffect(() => {
    setProfileState(loadProfile());
    itemsRef.current = loadItems();
    setItems(itemsRef.current);
    setChatState(loadChat());
    setPasswordState(readJson(STORAGE_KEYS.password, ""));
    setReady(true);
    getHealth()
      .then(setHealth)
      .catch(() => setHealth({ ok: false, aiConfigured: false, passwordRequired: false }));
  }, []);

  const setProfile = useCallback((next: Profile) => {
    setProfileState(next);
    return saveProfile(next);
  }, []);

  const addItem = useCallback((item: KnowledgeItem) => commitItems([item, ...itemsRef.current]), [commitItems]);

  const updateItem = useCallback(
    (id: string, patch: Partial<KnowledgeItem>) => {
      commitItems(itemsRef.current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    },
    [commitItems],
  );

  const deleteItem = useCallback(
    (id: string) => {
      commitItems(itemsRef.current.filter((item) => item.id !== id));
    },
    [commitItems],
  );

  const setChat = useCallback((next: ChatTurn[]) => {
    setChatState(next);
    saveChat(next);
  }, []);

  const setPassword = useCallback((next: string) => {
    setPasswordState(next);
    writeJson(STORAGE_KEYS.password, next);
  }, []);

  const exportBackup = useCallback(
    () => JSON.stringify(createBackup(profile, items, chat), null, 2),
    [profile, items, chat],
  );

  const importBackup = useCallback(
    (raw: string) => {
      const backup = parseBackup(raw);
      commitItems(mergeItems(itemsRef.current, backup.items));
      const hasProfile = Object.values(backup.profile).some((v) => typeof v === "string" && v.trim());
      if (hasProfile) setProfile(backup.profile);
      return { items: backup.items.length };
    },
    [commitItems, setProfile],
  );

  return {
    ready,
    health,
    profile,
    items,
    chat,
    password,
    setProfile,
    addItem,
    updateItem,
    deleteItem,
    setChat,
    setPassword,
    exportBackup,
    importBackup,
  };
}
