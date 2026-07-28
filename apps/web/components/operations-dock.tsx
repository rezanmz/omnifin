"use client";

import { Activity, Check, ChevronDown, Gauge, HardDrive, Network } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import type { OperationModel } from "../lib/dashboard-data";
import { handleDirectionalFocus } from "../lib/directional-focus";
import { useInterfaceStore } from "../stores/interface-store";

const AcquisitionTimeline = dynamic(
  () => import("./acquisition-timeline").then((module) => module.AcquisitionTimeline),
  { ssr: false },
);

const ManualReleaseWorkbench = dynamic(
  () => import("./manual-release-workbench").then((module) => module.ManualReleaseWorkbench),
  { ssr: false },
);

export function OperationsDock({ operations }: { operations: OperationModel[] }) {
  const expanded = useInterfaceStore((state) => state.operationsExpanded);
  const setExpanded = useInterfaceStore((state) => state.setOperationsExpanded);
  const average =
    operations.length > 0
      ? operations.reduce((total, operation) => total + operation.progress, 0) / operations.length
      : 0;
  const averagePercent = Math.round(average * 100);
  const [selectedOperation, setSelectedOperation] = useState<OperationModel | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);

  if (operations.length === 0) {
    return (
      <section
        className="operations-dock operations-dock--empty"
        aria-labelledby="operations-heading"
        data-liquid-glass
      >
        <div className="operations-dock__summary" role="status">
          <span className="operations-dock__beacon" aria-hidden="true">
            <Check size={18} />
          </span>
          <span className="operations-dock__title">
            <span className="section-kicker">Operations quiet</span>
            <strong id="operations-heading">No acquisitions in flight</strong>
          </span>
          <span className="operations-dock__quiet-copy">Your download queue is clear.</span>
        </div>
      </section>
    );
  }

  return (
    <section
      className="operations-dock"
      data-expanded={expanded || undefined}
      data-liquid-glass
      aria-labelledby="operations-heading"
      onKeyDown={(event) => handleDirectionalFocus(event, { axis: "vertical" })}
    >
      <button
        aria-controls="operations-details"
        aria-expanded={expanded}
        className="operations-dock__summary"
        data-directional-item
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="operations-dock__beacon" aria-hidden="true">
          <Activity size={18} />
        </span>
        <span className="operations-dock__title">
          <span className="section-kicker">Live operations</span>
          <strong id="operations-heading">{operations.length} acquisitions moving</strong>
        </span>
        <span
          aria-label="Average acquisition progress"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={averagePercent}
          className="operations-dock__meter"
          role="progressbar"
        >
          <span aria-hidden="true" style={{ width: `${averagePercent}%` }} />
        </span>
        <span className="operations-dock__metric">
          <Network aria-hidden="true" size={15} /> 61.0 MB/s
        </span>
        <span className="operations-dock__metric">
          <HardDrive aria-hidden="true" size={15} /> 4.8 TB free
        </span>
        <ChevronDown aria-hidden="true" className="operations-dock__chevron" size={19} />
      </button>
      <div
        aria-hidden={!expanded}
        className="operations-dock__details"
        id="operations-details"
        inert={!expanded ? true : undefined}
      >
        <div className="operations-dock__details-inner">
          <div className="operations-dock__list">
            {operations.map((operation) => (
              <button
                aria-label={`Inspect acquisition history for ${operation.title}`}
                className="operation-row"
                data-directional-item={expanded ? true : undefined}
                key={operation.id}
                onClick={() => {
                  setSelectedOperation(operation);
                  setTimelineOpen(true);
                }}
                tabIndex={expanded ? 0 : -1}
                type="button"
              >
                <span className="operation-row__icon" aria-hidden="true">
                  <Gauge size={17} />
                </span>
                <span className="operation-row__copy">
                  <strong>{operation.title}</strong>
                  <span>{operation.service}</span>
                </span>
                <span
                  aria-label={`${operation.title} progress`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(operation.progress * 100)}
                  className="operation-row__progress"
                  role="progressbar"
                >
                  <span
                    aria-hidden="true"
                    style={{ width: `${Math.round(operation.progress * 100)}%` }}
                  />
                </span>
                <span className="operation-row__rate">{operation.rate}</span>
                <span className="operation-row__eta">{operation.eta}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <AcquisitionTimeline
        onManualSearch={() => {
          setTimelineOpen(false);
          setWorkbenchOpen(true);
        }}
        onOpenChange={setTimelineOpen}
        open={timelineOpen}
        operation={selectedOperation}
      />
      <ManualReleaseWorkbench
        onOpenChange={setWorkbenchOpen}
        open={workbenchOpen}
        operation={selectedOperation}
      />
    </section>
  );
}
