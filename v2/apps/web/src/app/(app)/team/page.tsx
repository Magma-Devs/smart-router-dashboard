"use client";

export default function TeamPage() {
  return (
    <div className="gw-page">
      <h1>Team</h1>
      <p className="lede">Manage who can access this Smart Router dashboard.</p>
      <div className="gw-card">
        <p className="gw-card__title">Members</p>
        <div className="muted" style={{ padding: "20px 0", fontSize: 13 }}>
          This deployment uses a single shared login (basic auth). Team membership
          and roles aren&apos;t backed by a user store yet.
        </div>
      </div>
    </div>
  );
}
