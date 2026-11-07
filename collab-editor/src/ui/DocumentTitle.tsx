import React, { useState, useEffect, useRef } from "react";
import { ClientSync } from "collab-sync";

interface DocumentTitleProps {
  client: ClientSync;
  /** Bumps whenever any LWW meta field changes (from useCollabClient). */
  metaVersion: number;
}

export const DocumentTitle: React.FC<DocumentTitleProps> = ({ client, metaVersion }) => {
  const [title, setTitle] = useState("Untitled Document");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-read the title from LWW state whenever metaVersion changes.
  useEffect(() => {
    const remoteTitle = client.replica?.lww?.get("title");
    if (typeof remoteTitle === "string") {
      setTitle(remoteTitle);
    }
  }, [client, metaVersion]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Prevent Viewer from editing title
    if (client.getRole() === "viewer") return;

    const newTitle = e.target.value;
    setTitle(newTitle);

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      client.setMeta("title", newTitle);
    }, 300);
  };

  const isViewer = client.getRole() === "viewer";

  return (
    <input
      value={title}
      onChange={handleChange}
      placeholder="Untitled Document"
      readOnly={isViewer}
      style={{
        fontSize: "1.5rem",
        fontWeight: "bold",
        border: "none",
        outline: "none",
        flex: 1,
        color: isViewer ? "#666" : "inherit"
      }}
    />
  );
};
