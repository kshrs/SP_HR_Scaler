import React from 'react';
import type { BandItem } from '../types';

interface SidebarProps {
  isOpen: boolean;
  bands: BandItem[];
  activeBandId: string;
  onSelectBand: (bandId: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  bands,
  activeBandId,
  onSelectBand,
}) => {
  if (!isOpen) return null;

  const presets = bands.filter((b) => b.category === 'preset');
  const spectralBands = bands.filter((b) => b.category === 'band');
  const indices = bands.filter((b) => b.category === 'index');

  return (
    <nav
      className="w-72 bg-[#141619] border-r border-[#22272d] flex flex-col justify-between flex-shrink-0 z-20 h-full overflow-hidden select-none transition-all duration-300"
      data-purpose="primary-sidebar-navigation"
    >
      <div className="flex-1 overflow-y-auto py-2 space-y-1">
        {/* Section: Visual Compositions */}
        <div className="px-3 pb-1 pt-1 text-[10px] font-bold uppercase tracking-wider text-[#7a828e]/70 flex items-center justify-between">
          <span>Visual Compositions</span>
          <span className="text-[9px] font-mono text-[#00bcd4] bg-[#00bcd4]/10 px-1 py-0.5 rounded border border-[#00bcd4]/30">
            PRESETS
          </span>
        </div>

        {presets.map((item) => {
          const isActive = activeBandId === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectBand(item.id)}
              className={`w-full text-left flex items-center justify-between px-3 py-2 text-xs transition-colors cursor-pointer group ${
                isActive
                  ? 'text-white bg-[#17252c] border-l-2 border-[#00bcd4] font-medium'
                  : 'text-slate-300 hover:text-white hover:bg-[#1a1d22]'
              }`}
            >
              <div className="flex items-center space-x-2.5 min-w-0">
                <span
                  className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    item.id === 'rgb'
                      ? 'bg-[#00bcd4] shadow-[0_0_6px_#00bcd4]'
                      : item.id === 'difffusr'
                      ? 'bg-purple-500 shadow-[0_0_6px_#a855f7]'
                      : item.id === 'sr'
                      ? 'bg-amber-400 shadow-[0_0_6px_#f59e0b]'
                      : 'bg-rose-500/80'
                  }`}
                />
                <div className="flex flex-col min-w-0">
                  <span className={`truncate ${isActive ? 'text-white font-medium' : ''}`}>
                    {item.name}
                  </span>
                  <span
                    className={`text-[10px] font-mono ${
                      isActive ? 'text-[#00bcd4]/90' : 'text-[#7a828e]'
                    }`}
                  >
                    {item.description} • {item.resolution}
                  </span>
                </div>
              </div>
              <div
                className={`flex items-center space-x-1.5 flex-shrink-0 ${
                  isActive ? 'text-[#00bcd4]' : 'text-[#7a828e] opacity-40 group-hover:opacity-100'
                }`}
              >
                {isActive ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                    <path
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                  </svg>
                )}
              </div>
            </button>
          );
        })}

        {/* Section: Spectral Bands */}
        <div className="px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-wider text-[#7a828e]/70 flex items-center justify-between border-t border-[#22272d]/70">
          <span>Spectral Bands</span>
          <span className="text-[9px] font-mono text-[#7a828e]">MSI SENSOR</span>
        </div>

        {spectralBands.map((item) => {
          const isActive = activeBandId === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectBand(item.id)}
              className={`w-full text-left flex items-center justify-between px-3 py-1.5 text-xs transition-colors cursor-pointer group ${
                isActive
                  ? 'text-white bg-[#17252c] border-l-2 border-[#00bcd4] font-medium'
                  : 'text-slate-300 hover:text-white hover:bg-[#1a1d22]'
              }`}
            >
              <div className="flex items-center space-x-2.5 min-w-0">
                <span
                  className={`font-mono font-semibold text-[11px] w-7 flex-shrink-0 ${
                    item.badgeColor || 'text-cyan-400/90'
                  }`}
                >
                  {item.code}
                </span>
                <div className="flex flex-col min-w-0">
                  <span className={`truncate ${isActive ? 'text-white font-medium' : ''}`}>
                    {item.name}
                  </span>
                  <span
                    className={`text-[10px] font-mono ${
                      isActive ? 'text-[#00bcd4]/90' : 'text-[#7a828e]'
                    }`}
                  >
                    {item.wavelength ? `${item.wavelength} • ` : ''}
                    {item.resolution}
                  </span>
                </div>
              </div>
              <div
                className={`flex items-center space-x-1.5 flex-shrink-0 ${
                  isActive ? 'text-[#00bcd4]' : 'text-[#7a828e] opacity-40 group-hover:opacity-100'
                }`}
              >
                {isActive ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                    <path
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                    />
                  </svg>
                )}
              </div>
            </button>
          );
        })}

        {/* Section: Spectral Indices */}
        {indices.length > 0 && (
          <>
            <div className="px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-wider text-[#7a828e]/70 flex items-center justify-between border-t border-[#22272d]/70">
              <span>Spectral Indices</span>
              <span className="text-[9px] font-mono text-[#7a828e]">CALC</span>
            </div>

            {indices.map((item) => {
              const isActive = activeBandId === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onSelectBand(item.id)}
                  className={`w-full text-left flex items-center justify-between px-3 py-1.5 text-xs transition-colors cursor-pointer group ${
                    isActive
                      ? 'text-white bg-[#17252c] border-l-2 border-[#00bcd4] font-medium'
                      : 'text-slate-300 hover:text-white hover:bg-[#1a1d22]'
                  }`}
                >
                  <div className="flex items-center space-x-2.5 min-w-0">
                    <span
                      className={`font-mono font-semibold text-[11px] w-7 flex-shrink-0 ${
                        item.badgeColor || 'text-green-400'
                      }`}
                    >
                      {item.code}
                    </span>
                    <div className="flex flex-col min-w-0">
                      <span className={`truncate ${isActive ? 'text-white font-medium' : ''}`}>
                        {item.name}
                      </span>
                      <span
                        className={`text-[10px] font-mono ${
                          isActive ? 'text-[#00bcd4]/90' : 'text-[#7a828e]'
                        }`}
                      >
                        {item.description}
                      </span>
                    </div>
                  </div>
                  <div
                    className={`flex items-center space-x-1.5 flex-shrink-0 ${
                      isActive ? 'text-[#00bcd4]' : 'text-[#7a828e] opacity-40 group-hover:opacity-100'
                    }`}
                  >
                    {isActive ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                        />
                        <path
                          d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                        />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                        />
                      </svg>
                    )}
                  </div>
                </button>
              );
            })}
          </>
        )}
      </div>

      {/* Footer info in sidebar */}
      <div className="py-3 border-t border-[#22272d] space-y-0.5">
        <div className="px-3 py-1 flex items-center justify-between text-[11px] text-[#7a828e]">
          <span className="flex items-center space-x-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Sentinel-2A/B Live</span>
          </span>
          <span className="font-mono text-[10px] text-[#00bcd4]">{bands.length} Channels</span>
        </div>
      </div>
    </nav>
  );
};
