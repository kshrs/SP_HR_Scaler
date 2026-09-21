import React from 'react';

interface HeaderProps {
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  isSplitView: boolean;
  onToggleSplitView: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onRecenter: () => void;
  isSelectingAoi: boolean;
  onToggleSelectAoi: () => void;
  onExportGeoTiff: () => void;
  hasSelectedAoi: boolean;
  isExporting: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  isSidebarOpen,
  onToggleSidebar,
  isSplitView,
  onToggleSplitView,
  searchQuery,
  onSearchChange,
  onRecenter,
  isSelectingAoi,
  onToggleSelectAoi,
  onExportGeoTiff,
  hasSelectedAoi,
  isExporting,
}) => {
  return (
    <header
      className="h-14 bg-[#141619] border-b border-[#22272d] flex items-center justify-between px-4 z-30 flex-shrink-0 select-none"
      data-purpose="application-header"
    >
      <div className="flex items-center space-x-6">
        {/* Brand Logo & Title */}
        <div className="flex items-center space-x-3 w-44">
          <svg className="w-6 h-6 text-white" viewBox="0 0 24 24" fill="currentColor">
            <path d="M14.5 2.5L5.5 13h5.2L7.2 21.5l11.3-11h-5.8L16.2 2.5h-1.7z" />
          </svg>
          <span className="text-white text-lg font-semibold tracking-wide">Sentinel-2</span>
        </div>

        {/* Search Input Container */}
        <div className="relative w-80">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-[#7a828e]">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
              />
            </svg>
          </div>
          <input
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-[#191c20] border border-[#2b3036] rounded text-slate-200 placeholder-[#7a828e] focus:outline-none focus:border-[#00bcd4] transition-colors"
            placeholder="Search for location, coords..."
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      </div>

      {/* Right Header Actions */}
      <div className="flex items-center space-x-5 text-xs text-[#7a828e] font-medium">
        {/* GeoTIFF Square AOI Selector & Export Buttons */}
        <div className="flex items-center space-x-2 bg-[#191c20] border border-[#2b3036] p-1 rounded-md shadow-sm">
          <button
            type="button"
            onClick={onToggleSelectAoi}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs transition-colors cursor-pointer ${
              isSelectingAoi
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50'
                : hasSelectedAoi
                ? 'bg-[#22272d] text-emerald-300 border border-emerald-500/30'
                : 'text-slate-300 hover:text-white hover:bg-[#22272d]'
            }`}
            title="Select a square Area of Interest (AOI) on the map"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth="2" strokeDasharray={isSelectingAoi ? "3 3" : undefined} />
            </svg>
            <span>{isSelectingAoi ? 'Selecting AOI...' : hasSelectedAoi ? 'Square AOI' : 'Select AOI'}</span>
          </button>

          <button
            type="button"
            onClick={onExportGeoTiff}
            disabled={isExporting}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded text-xs font-medium transition-colors shadow-sm cursor-pointer ${
              isExporting
                ? 'bg-cyan-600/40 text-cyan-200 cursor-not-allowed animate-pulse'
                : 'bg-[#00bcd4] hover:bg-[#00acc1] text-[#111315] font-semibold'
            }`}
            title="Export all Sentinel-2 bands as GeoTIFF to Downloads folder"
          >
            {isExporting ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                <span>Exporting...</span>
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span>Export GeoTIFF</span>
              </>
            )}
          </button>
        </div>

        {/* Swin2SR Split-View Compare Slider Toggle Button */}
        <div
          className="flex items-center space-x-2 cursor-pointer select-none group"
          onClick={onToggleSplitView}
          title="Toggle Swin2SR Super-Resolution Split-Screen Comparison"
        >
          <span className="text-xs text-[#7a828e] group-hover:text-white transition-colors font-medium flex items-center space-x-1.5">
            <span className={`w-2 h-2 rounded-full ${isSplitView ? 'bg-amber-400 animate-pulse' : 'bg-[#7a828e]'}`} />
            <span>Swin2SR Split</span>
          </span>
          <button
            aria-checked={isSplitView}
            role="switch"
            type="button"
            className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer rounded-full border p-0.5 transition-colors duration-200 ease-in-out focus:outline-none shadow-sm ${
              isSplitView
                ? 'border-amber-400/60 bg-amber-400/20'
                : 'border-[#2b3038] bg-[#191c20]'
            }`}
            title="Toggle Swin2SR Comparison"
          >
            <span
              className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full shadow transition-transform duration-200 ease-in-out ${
                isSplitView
                  ? 'translate-x-5 bg-amber-400'
                  : 'translate-x-0 bg-[#7a828e]'
              }`}
            />
          </button>
        </div>

        {/* Sidebar toggle slider */}
        <div
          className="flex items-center space-x-2 cursor-pointer select-none group"
          onClick={onToggleSidebar}
        >
          <span className="text-xs text-[#7a828e] group-hover:text-white transition-colors font-medium">
            Sidebar
          </span>
          <button
            aria-checked={isSidebarOpen}
            role="switch"
            type="button"
            className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer rounded-full border p-0.5 transition-colors duration-200 ease-in-out focus:outline-none shadow-sm ${
              isSidebarOpen
                ? 'border-[#00bcd4]/60 bg-[#00bcd4]/20'
                : 'border-[#2b3038] bg-[#191c20]'
            }`}
            title="Toggle Sidebar Slider"
          >
            <span
              className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full shadow transition-transform duration-200 ease-in-out ${
                isSidebarOpen
                  ? 'translate-x-5 bg-[#00bcd4]'
                  : 'translate-x-0 bg-[#7a828e]'
              }`}
            />
          </button>
        </div>

        {/* User Avatar Profile / Re-center Location */}
        <button
          onClick={onRecenter}
          className="flex items-center justify-center w-8 h-8 rounded-full border border-red-500/40 bg-red-500/10 text-red-500 hover:bg-red-500/20 hover:border-red-500 transition-colors shadow-sm cursor-pointer"
          title="Re-center to target AOI"
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="2" fill="currentColor" />
            <line x1="12" y1="2" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="2" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="22" y2="12" />
          </svg>
        </button>
      </div>
    </header>
  );
};
