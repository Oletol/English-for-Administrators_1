// Тесты правил безопасности. Запуск:
//   npx firebase emulators:exec --only firestore "node --test tests/"
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp, arrayUnion,
  collection, getDocs, query, where,
} from 'firebase/firestore';

let env;
const T = 'teacher1', A = 'alice', B = 'bob';

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-course',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'teachers', T), { name: 'Teacher' });
    await setDoc(doc(db, 'groups', 'G1'), { name: 'Group 1', openUnits: ['u1'], releasedUnits: [] });
    await setDoc(doc(db, 'groups', 'G2'), { name: 'Group 2', openUnits: [], releasedUnits: [] });
    await setDoc(doc(db, 'users', A), { name: 'Alice', email: 'a@x.ru', groupId: 'G1' });
    await setDoc(doc(db, 'users', B), { name: 'Bob', email: 'b@x.ru', groupId: 'G2' });
    await setDoc(doc(db, 'units', 'u1'), { title: 'Unit 1', order: 1 });
    await setDoc(doc(db, 'unitContent', 'u1'), { sections: [] });
    await setDoc(doc(db, 'answerKeys', 'u1'), { exercises: { e1: { 1: 'sends' } } });
  });
});

const as = (uid, email) => env.authenticatedContext(uid, { email: email || `${uid}@x.ru` }).firestore();
const draft = (uid, gid, extra = {}) => ({
  uid, groupId: gid, unitId: 'u1', answers: { e1: { 1: 'send' } },
  status: 'draft', updatedAt: serverTimestamp(), ...extra,
});

// ---------- роли ----------
test('студент не может назначить себя преподавателем', async () => {
  await assertFails(setDoc(doc(as(A), 'teachers', A), { name: 'hack' }));
});
test('студент не может добавить себе поле role или сменить группу', async () => {
  await assertFails(updateDoc(doc(as(A), 'users', A), { role: 'teacher' }));
  await assertFails(updateDoc(doc(as(A), 'users', A), { groupId: 'G2' }));
  await assertSucceeds(updateDoc(doc(as(A), 'users', A), { name: 'Alice K.' }));
});
test('регистрация: только с существующим кодом группы и без лишних полей', async () => {
  const db = as('carol', 'c@x.ru');
  const base = { name: 'Carol', email: 'c@x.ru', createdAt: serverTimestamp() };
  await assertFails(setDoc(doc(db, 'users', 'carol'), { ...base, groupId: 'NOPE' }));
  await assertFails(setDoc(doc(db, 'users', 'carol'), { ...base, groupId: 'G1', role: 'teacher' }));
  await assertSucceeds(setDoc(doc(db, 'users', 'carol'), { ...base, groupId: 'G1' }));
});
test('преподаватель переводит студента в другую группу', async () => {
  await assertSucceeds(updateDoc(doc(as(T), 'users', A), { groupId: 'G2' }));
});

// ---------- доступ к контенту ----------
test('ключи недоступны студенту даже при открытом юните', async () => {
  await assertFails(getDoc(doc(as(A), 'answerKeys', 'u1')));
  await assertSucceeds(getDoc(doc(as(T), 'answerKeys', 'u1')));
});
test('контент юнита виден только группе, для которой он открыт', async () => {
  await assertSucceeds(getDoc(doc(as(A), 'unitContent', 'u1')));   // G1 — открыт
  await assertFails(getDoc(doc(as(B), 'unitContent', 'u1')));      // G2 — закрыт
});
test('студент не может открыть юнит своей группе', async () => {
  await assertFails(updateDoc(doc(as(A), 'groups', 'G1'), { openUnits: arrayUnion('u2') }));
  await assertFails(getDoc(doc(as(A), 'groups', 'G2')));           // чужая группа
  await assertSucceeds(getDoc(doc(as(A), 'groups', 'G1')));
});

// ---------- черновики и сдача ----------
test('черновик: свой — можно, чужой — нельзя, в закрытый юнит — нельзя', async () => {
  await assertSucceeds(setDoc(doc(as(A), 'submissions', `u1__${A}`), draft(A, 'G1')));
  await assertFails(setDoc(doc(as(A), 'submissions', `u1__${B}`), draft(B, 'G1')));
  await assertFails(setDoc(doc(as(B), 'submissions', `u1__${B}`), draft(B, 'G2')));
  await assertFails(getDoc(doc(as(B), 'submissions', `u1__${A}`)));
});
test('нельзя подделать группу в черновике', async () => {
  await assertFails(setDoc(doc(as(A), 'submissions', `u1__${A}`), draft(A, 'G2')));
});
test('после сдачи работу нельзя менять', async () => {
  const db = as(A);
  await assertSucceeds(setDoc(doc(db, 'submissions', `u1__${A}`),
    draft(A, 'G1', { status: 'submitted', submittedAt: serverTimestamp() })));
  await assertFails(setDoc(doc(db, 'submissions', `u1__${A}`), draft(A, 'G1')));
  // преподаватель возвращает на доработку → снова можно
  await assertSucceeds(updateDoc(doc(as(T), 'submissions', `u1__${A}`), { status: 'draft' }));
  await assertSucceeds(setDoc(doc(db, 'submissions', `u1__${A}`), draft(A, 'G1')));
});
test('после включения проверки черновик менять нельзя', async () => {
  await assertSucceeds(setDoc(doc(as(A), 'submissions', `u1__${A}`), draft(A, 'G1')));
  await updateDoc(doc(as(T), 'groups', 'G1'), { releasedUnits: arrayUnion('u1') });
  await assertFails(setDoc(doc(as(A), 'submissions', `u1__${A}`), draft(A, 'G1')));
});

// ---------- результаты ----------
test('результат: студент не может писать; видит только свой и только после включения проверки', async () => {
  const res = { uid: A, groupId: 'G1', unitId: 'u1', score: 1, max: 1 };
  await assertFails(setDoc(doc(as(A), 'results', `u1__${A}`), res));
  await assertSucceeds(setDoc(doc(as(T), 'results', `u1__${A}`), res));
  await assertFails(getDoc(doc(as(A), 'results', `u1__${A}`)));     // ещё не включено
  await updateDoc(doc(as(T), 'groups', 'G1'), { releasedUnits: arrayUnion('u1') });
  await assertSucceeds(getDoc(doc(as(A), 'results', `u1__${A}`)));
  await assertFails(getDoc(doc(as(B), 'results', `u1__${A}`)));     // чужой
});
test('студент не может выгрузить чужие работы запросом', async () => {
  await assertFails(getDocs(query(collection(as(A), 'submissions'), where('groupId', '==', 'G1'))));
  await assertSucceeds(getDocs(query(collection(as(T), 'submissions'), where('groupId', '==', 'G1'), where('unitId', '==', 'u1'))));
});

// ---------- проверка отдельных упражнений ----------
test('после проверки упражнения студент не может менять ответы в нём, но может в остальных', async () => {
  const db = as(A);
  await assertSucceeds(setDoc(doc(db, 'submissions', `u1__${A}`), draft(A, 'G1', { answers: { e1: { 1: 'x' }, e2: { 1: 'y' } } })));
  await updateDoc(doc(as(T), 'groups', 'G1'), { 'releasedEx.u1': arrayUnion('e1') });
  await assertFails(setDoc(doc(db, 'submissions', `u1__${A}`), draft(A, 'G1', { answers: { e1: { 1: 'changed' }, e2: { 1: 'y' } } })));
  await assertSucceeds(setDoc(doc(db, 'submissions', `u1__${A}`), draft(A, 'G1', { answers: { e1: { 1: 'x' }, e2: { 1: 'new' } } })));
});
test('результаты отдельных упражнений: пишет только преподаватель, читает владелец', async () => {
  const r = { uid: A, groupId: 'G1', unitId: 'u1', items: { e1: { 1: { ok: true } } } };
  await assertFails(setDoc(doc(as(A), 'exerciseResults', `u1__${A}`), r));
  await assertSucceeds(setDoc(doc(as(T), 'exerciseResults', `u1__${A}`), r));
  await assertSucceeds(getDoc(doc(as(A), 'exerciseResults', `u1__${A}`)));
  await assertFails(getDoc(doc(as(B), 'exerciseResults', `u1__${A}`)));
});
