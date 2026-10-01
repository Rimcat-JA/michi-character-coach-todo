import { resolveLocalCalendarTime } from './calendar-resolver'

export const CSV_FILE_LIMIT = 1048576
export async function readCalendarCSVFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<Uint8Array> {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > CSV_FILE_LIMIT) throw new Error('空でないUTF-8のCSVファイルを1MiB以内で選んでください。')
  let bytes: Uint8Array
  try { bytes = new Uint8Array(await file.arrayBuffer()) } catch { throw new Error('ファイルを読み取れませんでした。移動・削除・アクセス権を確認して選び直してください。') }
  if (bytes.byteLength !== file.size) throw new Error('選択後にファイルのサイズが変わりました。選び直してください。')
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('CSVはUTF-8で保存してください。文字化けした内容を置換して取り込みません。') }
  return bytes
}
export function calendarCSVRetentionUntil(value: string, timezone: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/)
  if (!match || !timezone) throw new Error('原文の保持期限と、そのタイムゾーンを明示してください。')
  const result = resolveLocalCalendarTime(match[1], match[2], timezone)
  if (!result.at) throw new Error(result.reason ?? '保持期限の時刻が曖昧です。別の時刻を選んでください。')
  if (Date.parse(result.at) <= Date.now()) throw new Error('原文の保持期限は現在より後に指定してください。')
  return result.at
}
