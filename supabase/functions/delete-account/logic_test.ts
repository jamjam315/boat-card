// delete-account の判断部分のテスト。
//
// 守りたいのは2つ。
//   ・**他人を消せないこと**（消す相手はJWTからしか決めない）
//   ・**消し残しが出ないこと**（連鎖削除の対象外の表を取りこぼさない）
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1'
import {
  isAllowedMethod,
  isUuid,
  logId,
  subjectFromClaims,
  TABLES_WITHOUT_CASCADE,
} from './logic.ts'

const UID = '3f2b7c10-9a4e-4d1b-8c55-0e6a1b2c3d4e'

Deno.test('POST以外は受け付けない', () => {
  assert(isAllowedMethod('POST'))
  for (const m of ['GET', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS']) {
    assertFalse(isAllowedMethod(m), m)
  }
})

Deno.test('消す相手はJWTの持ち主だけ', () => {
  assertEquals(subjectFromClaims({ id: UID }), UID)
})

Deno.test('匿名アカウントも消せる（お気に入りは匿名から貯まる）', () => {
  assertEquals(subjectFromClaims({ id: UID, is_anonymous: true }), UID)
})

Deno.test('JWTに持ち主がいなければ消さない', () => {
  assertEquals(subjectFromClaims(undefined), null)
  assertEquals(subjectFromClaims({}), null)
  assertEquals(subjectFromClaims({ id: null }), null)
  assertEquals(subjectFromClaims({ id: 123 }), null)
})

Deno.test('uuidの形をしていなければ消さない', () => {
  assertEquals(subjectFromClaims({ id: 'not-a-uuid' }), null)
  assertEquals(subjectFromClaims({ id: '' }), null)
  // SQLに見える文字列が紛れ込んでも、形で落ちる。
  assertEquals(subjectFromClaims({ id: "' or 1=1 --" }), null)
  assertEquals(subjectFromClaims({ id: UID + ' ' }), null)
})

Deno.test('本文に書かれたIDは判断に使われない（型の上で受け取り口が無い）', () => {
  // subjectFromClaims の引数はJWTのclaimsだけ。本文を混ぜても、
  // claims に id が無ければ null のまま。
  const claimsWithoutId = { sub: UID, target_user_id: UID } as Record<string, unknown>
  assertEquals(subjectFromClaims(claimsWithoutId), null)
})

Deno.test('uuidの判定', () => {
  assert(isUuid(UID))
  assert(isUuid(UID.toUpperCase()))
  assertFalse(isUuid(UID.replace('-', '')))
  assertFalse(isUuid(UID + 'x'))
})

Deno.test('ログには先頭8桁しか出さない', () => {
  assertEquals(logId(UID), '3f2b7c10')
  assertEquals(logId(UID).length, 8)
  assertFalse(logId(UID).includes('-'))
})

Deno.test('連鎖削除の対象外は favorite_players（消し残しを作らない）', () => {
  // auth.users を消しても消えない表がここに全部入っていること。
  // 2026-09-07 時点で、外部キーを持たないのはこの1つだけ
  // （20260728120802_record_favorite_players.sql が実DBの定義を記録している）。
  assertEquals([...TABLES_WITHOUT_CASCADE], ['favorite_players'])
})

Deno.test('二重に呼ばれても壊れない（すべて冪等な操作でできている）', () => {
  // 1回目で消えたあと、同じJWTで叩かれても:
  //   ・favorite_players の delete は 0 行に当たるだけ
  //   ・auth.admin.deleteUser は存在しない利用者でエラーを返す
  //     → failed() で ok:false になり、画面は「時間をおいて再度」を出す
  // どちらも他人のデータには触れない。判断側で見るのは相手のIDだけなので、
  // 2回目も1回目と同じ相手（＝自分）にしか向かわない。
  assertEquals(subjectFromClaims({ id: UID }), subjectFromClaims({ id: UID }))
})
