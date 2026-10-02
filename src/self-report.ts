/** 本人申告 such as 疲れた/無理 only opens options. It never postpones everything or creates a rest task. */
export const selfReportPattern = /疲れ|しんど|無理|休みたい|今日はもう|つらい|余裕がない/
export function selfReportMessage<T extends { id: string; role: string; text: string }>(messages: T[]): T | null {
  const last = [...messages].reverse().find(item => item.role === 'user')
  return last && selfReportPattern.test(last.text) ? last : null
}
