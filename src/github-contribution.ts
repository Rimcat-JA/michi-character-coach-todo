import type { AchievementExport } from './achievements'
export function githubContributionLabel(status:AchievementExport['contribution']):string{
 switch(status){
  case 'not_published':return '未投稿'
  case 'pr_pending':return 'PR反映待ち・未マージ'
  case 'pending':return '反映待ち・当該commitの独立反映は未確認'
  case 'unverified':return '集計条件・反映は未確認'
  case 'conditions_met':return '集計条件を確認済み（GitHub標準の草への反映は未確認）'
  case 'conditions_not_met':return '集計条件不足・草への反映は未確認'
  case 'conditions_unknown':return '集計条件は確認不能・草への反映は未確認'
  default:{const never:never=status;throw new Error(`不正な集計状態: ${never}`)}
 }
}
