import React from 'react';
import * as Select from '@radix-ui/react-select';

type Option = { value: string; label: string; description?: string; image?: string };
export function ComposerSelect({ label, value, options, change, disabled = false }: {
  label: string; value: string; options: Option[]; change(value: string): void; disabled?: boolean;
}) {
  return <Select.Root value={value} onValueChange={change} disabled={disabled}>
    <Select.Trigger className="composer-select-trigger" aria-label={label}>
      <Select.Value /><Select.Icon className="composer-select-chevron"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg></Select.Icon>
    </Select.Trigger>
    <Select.Portal><Select.Content className="composer-select-menu" data-composer-picker-content="" position="popper" side="top" align="start" sideOffset={8} collisionPadding={12}>
      <Select.ScrollUpButton className="composer-select-scroll">⌃</Select.ScrollUpButton>
      <Select.Viewport><Select.Group><Select.Label className="composer-select-label">{label}</Select.Label>
        {options.map(option => <Select.Item className="composer-select-item" key={option.value} value={option.value} textValue={option.label}>
          {option.image && <img className="composer-select-avatar" src={option.image} alt="" />}
          <span className="composer-select-copy"><Select.ItemText>{option.label}</Select.ItemText>{option.description && <small>{option.description}</small>}</span>
          <Select.ItemIndicator className="composer-select-check"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></Select.ItemIndicator>
        </Select.Item>)}
      </Select.Group></Select.Viewport>
      <Select.ScrollDownButton className="composer-select-scroll">⌄</Select.ScrollDownButton>
    </Select.Content></Select.Portal>
  </Select.Root>;
}
