import { describe, expect, it } from 'vitest';
import {
  CAP_LABELS,
  ROLES,
  capabilitiesOf,
  isRole,
  primaryRole,
} from '../src/modules/users/roles.js';

describe('roles', () => {
  it('ROLES 含四个角色', () => {
    expect([...ROLES].sort()).toEqual([
      'admin',
      'dashboard_author',
      'dashboard_viewer',
      'workflow_author',
    ]);
  });

  it('isRole 正确识别合法与非法值', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('user')).toBe(false);
    expect(isRole(1)).toBe(false);
  });

  it('capabilitiesOf 单个角色返回其能力集合', () => {
    expect([...capabilitiesOf(['dashboard_viewer'])].sort()).toEqual(['dashboard.view']);
  });

  it('capabilitiesOf 多角色返回能力并集', () => {
    const caps = capabilitiesOf(['dashboard_author', 'dashboard_viewer']);
    expect(caps.has('dashboard.edit')).toBe(true);
    expect(caps.has('dashboard.view')).toBe(true);
    expect(caps.size).toBe(3);
  });

  it('capabilitiesOf admin 拥有八项能力', () => {
    expect(capabilitiesOf(['admin']).size).toBe(8);
  });

  it('primaryRole 按优先级返回', () => {
    expect(primaryRole(['dashboard_viewer', 'admin'])).toBe('admin');
    expect(primaryRole(['dashboard_author', 'workflow_author'])).toBe('workflow_author');
  });

  it('primaryRole 空数组回退到 dashboard_viewer', () => {
    expect(primaryRole([])).toBe('dashboard_viewer');
  });

  it('CAP_LABELS 提供非空标签', () => {
    expect(CAP_LABELS['connection.manage'].length).toBeGreaterThan(0);
  });
});
