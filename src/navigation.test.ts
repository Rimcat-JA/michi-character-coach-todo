import { expect, it } from 'vitest'
import { findNavigation, visibleNavigation } from './navigation'

it('PCとスマホの表示設定を独立させ、全て隠しても機能検索が設定へ到達する', () => {
  expect(visibleNavigation(['today', 'wall'], 'desktop')).toEqual(['today', 'wall'])
  expect(visibleNavigation(undefined, 'mobile')).toEqual(['today', 'tasks', 'coach', 'history'])
  expect(visibleNavigation([], 'desktop')).toEqual([])
  expect(visibleNavigation([], 'mobile')).toEqual([])
  expect(findNavigation([{ view: 'settings', label: '設定とデータ' }, { view: 'wall', label: '付箋のWall' }], '設定')).toBe('settings')
})
