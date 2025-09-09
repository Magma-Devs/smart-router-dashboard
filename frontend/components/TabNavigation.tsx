"use client"

interface TabNavigationProps {
  activeTab: "chains" | "providers"
  onTabChange: (tab: "chains" | "providers") => void
}

export function TabNavigation({ activeTab, onTabChange }: TabNavigationProps) {
  return (
    <div className="flex space-x-1 mb-6">
      <button
        onClick={() => onTabChange("chains")}
        className={`px-6 py-3 text-lg font-medium transition-colors ${
          activeTab === "chains"
            ? "text-white border-b-2 border-white"
            : "text-muted-foreground hover:text-white"
        }`}
      >
        Chains
      </button>
      <button
        onClick={() => onTabChange("providers")}
        className={`px-6 py-3 text-lg font-medium transition-colors ${
          activeTab === "providers"
            ? "text-white border-b-2 border-white"
            : "text-muted-foreground hover:text-white"
        }`}
      >
        Providers
      </button>
    </div>
  )
}
