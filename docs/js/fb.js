// Единая точка подключения Firebase. Версию SDK меняйте только здесь.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Офлайн-кэш в IndexedDB: несохранённые записи переживают закрытие вкладки
// и отправляются на сервер при следующем открытии.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// Локальная отладка с эмуляторами: http://localhost:5000/?emu
if (["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).has("emu")) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

export * from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
export * from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
