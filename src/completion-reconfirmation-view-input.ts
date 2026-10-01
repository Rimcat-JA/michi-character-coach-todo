export function reconfirmationPoints(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 100000) throw new Error('再確定するポイントを0〜100000の整数で入力してください。空欄は0にはしません。')
  return Number(value)
}
