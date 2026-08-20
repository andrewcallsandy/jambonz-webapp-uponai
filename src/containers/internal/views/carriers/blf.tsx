import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ButtonGroup, Icon, MS, MXS } from "@jambonz/ui-kit";

import {
  deleteBlfConfiguration,
  deleteBlfMonitor,
  getBlfAvailability,
  getBlfConfigurations,
  getBlfMonitors,
  postBlfConfiguration,
  postBlfMonitor,
  postBlfRotateToken,
  putBlfConfiguration,
  putBlfMonitor,
} from "src/api";
import type {
  BlfAvailabilityResponse,
  BlfConfiguration,
  BlfEventPackage,
  BlfMonitor,
  Carrier,
  FetchError,
} from "src/api/types";
import { ClipBoard, Icons } from "src/components";
import { Selector } from "src/components/forms";
import { useToast } from "src/components/toast/toast-provider";

type CarrierBlfPanelProps = {
  carrier: Carrier;
  /** Form account selection (may differ from saved until Save) */
  accountSid: string;
  trunkType: string;
  requiresRegister: boolean;
};

const EVENT_OPTIONS = [
  { name: "dialog (recommended)", value: "dialog" },
  { name: "presence", value: "presence" },
];

const errMsg = (err: unknown, fallback: string) => {
  const fe = err as FetchError | undefined;
  return fe?.msg || fallback;
};

const stateColor = (state?: string, available?: boolean) => {
  if (available) return "teal";
  if (state === "ringing") return "purple";
  if (state === "busy" || state === "held") return "jam";
  if (state === "unavailable") return "jean";
  return "jean";
};

export const isBlfEligible = (
  accountSid: string,
  trunkType: string,
  requiresRegister: boolean,
) => {
  if (!accountSid) return false;
  if (trunkType === "reg") return true;
  if (trunkType === "auth" && requiresRegister) return true;
  return false;
};

export const CarrierBlfPanel = ({
  carrier,
  accountSid,
  trunkType,
  requiresRegister,
}: CarrierBlfPanelProps) => {
  const { toastSuccess, toastError } = useToast();
  const eligible = isBlfEligible(accountSid, trunkType, requiresRegister);
  const savedAccountSid = carrier.account_sid || "";
  const canManage =
    eligible &&
    !!savedAccountSid &&
    savedAccountSid === accountSid &&
    !!carrier.voip_carrier_sid;

  const defaultDomain =
    carrier.register_from_domain || carrier.register_sip_realm || "";

  const [loading, setLoading] = useState(false);
  const [cfg, setCfg] = useState<BlfConfiguration | null>(null);
  const [monitors, setMonitors] = useState<BlfMonitor[]>([]);
  const [availability, setAvailability] =
    useState<BlfAvailabilityResponse | null>(null);

  const [eventPackage, setEventPackage] = useState<BlfEventPackage>("dialog");
  const [subscribeExpires, setSubscribeExpires] = useState(3600);
  const [staleSeconds, setStaleSeconds] = useState(120);
  const [enabled, setEnabled] = useState(true);

  const [newExt, setNewExt] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newUri, setNewUri] = useState("");

  const availabilityByExt = useMemo(() => {
    const map = new Map<
      string,
      { available: boolean; state: string; stale: boolean }
    >();
    for (const e of availability?.extensions || []) {
      map.set(String(e.extension), {
        available: e.available,
        state: String(e.state),
        stale: e.stale,
      });
    }
    return map;
  }, [availability]);

  const loadAll = useCallback(async () => {
    if (!canManage) {
      setCfg(null);
      setMonitors([]);
      setAvailability(null);
      return;
    }
    setLoading(true);
    try {
      const { json: configs } = await getBlfConfigurations(savedAccountSid);
      const match =
        (configs || []).find(
          (c) => c.voip_carrier_sid === carrier.voip_carrier_sid,
        ) || null;
      setCfg(match);
      if (match) {
        setEventPackage(match.event_package || "dialog");
        setSubscribeExpires(match.subscribe_expires || 3600);
        setStaleSeconds(match.stale_seconds || 120);
        setEnabled(!!match.is_enabled);
        const [{ json: mons }, { json: avail }] = await Promise.all([
          getBlfMonitors(savedAccountSid, match.blf_configuration_sid),
          getBlfAvailability(savedAccountSid, match.blf_configuration_sid),
        ]);
        setMonitors(mons || []);
        setAvailability(avail || null);
      } else {
        setMonitors([]);
        setAvailability(null);
      }
    } catch (err) {
      toastError(errMsg(err, "Failed to load BLF configuration"));
    } finally {
      setLoading(false);
    }
  }, [canManage, savedAccountSid, carrier.voip_carrier_sid, toastError]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Keep live availability fresh while the BLF tab is open
  useEffect(() => {
    if (!canManage || !cfg?.blf_configuration_sid) return undefined;
    const id = window.setInterval(() => {
      getBlfAvailability(savedAccountSid, cfg.blf_configuration_sid)
        .then(({ json }) => {
          if (json) setAvailability(json);
        })
        .catch(() => undefined);
      getBlfMonitors(savedAccountSid, cfg.blf_configuration_sid)
        .then(({ json }) => {
          if (json) setMonitors(json);
        })
        .catch(() => undefined);
    }, 10000);
    return () => window.clearInterval(id);
  }, [canManage, cfg?.blf_configuration_sid, savedAccountSid]);

  useEffect(() => {
    if (!newExt || newUri) return;
    if (!defaultDomain) return;
    setNewUri(`sip:${newExt}@${defaultDomain}`);
  }, [newExt, defaultDomain]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    if (!canManage) return;
    setLoading(true);
    try {
      const { json } = await postBlfConfiguration(savedAccountSid, {
        voip_carrier_sid: carrier.voip_carrier_sid,
        is_enabled: enabled,
        event_package: eventPackage,
        subscribe_expires: subscribeExpires,
        stale_seconds: staleSeconds,
      });
      toastSuccess(
        json?.upserted
          ? "BLF configuration already existed — loaded existing"
          : "BLF configuration created",
      );
      if (json?.capability_token) {
        toastSuccess("Store the capability token — shown only on create");
      }
      await loadAll();
    } catch (err) {
      toastError(errMsg(err, "Failed to create BLF configuration"));
      setLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!canManage || !cfg) return;
    setLoading(true);
    try {
      await putBlfConfiguration(savedAccountSid, cfg.blf_configuration_sid, {
        is_enabled: enabled,
        event_package: eventPackage,
        subscribe_expires: subscribeExpires,
        stale_seconds: staleSeconds,
      });
      toastSuccess("BLF settings updated");
      await loadAll();
    } catch (err) {
      toastError(errMsg(err, "Failed to update BLF settings"));
      setLoading(false);
    }
  };

  const handleDeleteConfig = async () => {
    if (!canManage || !cfg) return;
    if (
      !window.confirm(
        "Delete BLF configuration and all monitors for this carrier?",
      )
    ) {
      return;
    }
    setLoading(true);
    try {
      await deleteBlfConfiguration(savedAccountSid, cfg.blf_configuration_sid);
      toastSuccess("BLF configuration deleted");
      setCfg(null);
      setMonitors([]);
      setAvailability(null);
    } catch (err) {
      toastError(errMsg(err, "Failed to delete BLF configuration"));
    } finally {
      setLoading(false);
    }
  };

  const handleRotate = async () => {
    if (!canManage || !cfg) return;
    if (
      !window.confirm(
        "Rotate the public capability token? Existing Retell/public URLs will stop working.",
      )
    ) {
      return;
    }
    setLoading(true);
    try {
      const { json } = await postBlfRotateToken(
        savedAccountSid,
        cfg.blf_configuration_sid,
      );
      toastSuccess("Capability token rotated");
      setCfg((prev) =>
        prev
          ? {
              ...prev,
              capability_url: json.capability_url,
              capability_token: json.capability_token,
            }
          : prev,
      );
    } catch (err) {
      toastError(errMsg(err, "Failed to rotate token"));
    } finally {
      setLoading(false);
    }
  };

  const handleAddMonitor = async () => {
    if (!canManage || !cfg) return;
    const extension = newExt.trim();
    const presentity_uri = newUri.trim();
    if (!extension || !presentity_uri) {
      toastError("Extension and presentity URI are required");
      return;
    }
    setLoading(true);
    try {
      await postBlfMonitor(savedAccountSid, cfg.blf_configuration_sid, {
        extension,
        display_name: newLabel.trim() || null,
        presentity_uri,
        is_enabled: true,
      });
      toastSuccess(`Monitor ${extension} added`);
      setNewExt("");
      setNewLabel("");
      setNewUri("");
      await loadAll();
    } catch (err) {
      toastError(errMsg(err, "Failed to add monitor"));
      setLoading(false);
    }
  };

  const handleToggleMonitor = async (m: BlfMonitor) => {
    if (!canManage || !cfg) return;
    setLoading(true);
    try {
      await putBlfMonitor(
        savedAccountSid,
        cfg.blf_configuration_sid,
        m.blf_monitor_sid,
        { is_enabled: !m.is_enabled },
      );
      await loadAll();
    } catch (err) {
      toastError(errMsg(err, "Failed to update monitor"));
      setLoading(false);
    }
  };

  const handleDeleteMonitor = async (m: BlfMonitor) => {
    if (!canManage || !cfg) return;
    if (!window.confirm(`Remove monitor for extension ${m.extension}?`)) {
      return;
    }
    setLoading(true);
    try {
      await deleteBlfMonitor(
        savedAccountSid,
        cfg.blf_configuration_sid,
        m.blf_monitor_sid,
      );
      toastSuccess(`Monitor ${m.extension} removed`);
      await loadAll();
    } catch (err) {
      toastError(errMsg(err, "Failed to delete monitor"));
      setLoading(false);
    }
  };

  if (!accountSid) {
    return (
      <fieldset>
        <MS>
          Assign this carrier to an <strong>account</strong> on the General tab
          and save before configuring BLF.
        </MS>
      </fieldset>
    );
  }

  if (!eligible) {
    return (
      <fieldset>
        <MS>
          BLF requires a registration-capable trunk (<strong>reg</strong>, or{" "}
          <strong>auth</strong> with SIP registration enabled). Update trunk
          settings on General / Outbound &amp; Registration, then save.
        </MS>
      </fieldset>
    );
  }

  if (!canManage) {
    return (
      <fieldset>
        <MS>
          Save the carrier with the selected account and registration settings
          before managing BLF. Current saved account must match the form
          selection.
        </MS>
      </fieldset>
    );
  }

  return (
    <>
      <fieldset>
        <div className="label">Live Extension Availability (BLF)</div>
        <MXS>
          <em>
            Subscribe to extension dialog state on this registered trunk. Used
            for Retell / availability tools. Not a PBX directory sync.
          </em>
        </MXS>
        {loading && (
          <MS>
            <em>Loading…</em>
          </MS>
        )}
      </fieldset>

      {!cfg ? (
        <fieldset>
          <label htmlFor="blf_event_package">Event package</label>
          <Selector
            id="blf_event_package"
            name="blf_event_package"
            value={eventPackage}
            options={EVENT_OPTIONS}
            onChange={(e) => setEventPackage(e.target.value as BlfEventPackage)}
          />
          <label className="chk" htmlFor="blf_enabled_create">
            <input
              id="blf_enabled_create"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <div>Enable immediately</div>
          </label>
          <ButtonGroup left>
            <Button
              type="button"
              small
              disabled={loading}
              onClick={handleCreate}
            >
              Enable BLF for this carrier
            </Button>
          </ButtonGroup>
        </fieldset>
      ) : (
        <>
          <fieldset>
            <div
              className={`i txt--${cfg.is_enabled ? "teal" : "jean"}`}
              style={{ marginBottom: "0.75rem" }}
            >
              {cfg.is_enabled ? <Icons.CheckCircle /> : <Icons.XCircle />}
              <span>
                BLF {cfg.is_enabled ? "enabled" : "disabled"}
                {cfg.monitors
                  ? ` · ${cfg.monitors.active_subscriptions}/${cfg.monitors.total} subscriptions active`
                  : ""}
              </span>
            </div>
            {cfg.last_error && (
              <MS>
                <strong>Last error:</strong> {cfg.last_error}
              </MS>
            )}
            {cfg.last_reconcile_at && (
              <MS>
                <strong>Last reconcile:</strong> {cfg.last_reconcile_at}
              </MS>
            )}

            <label className="chk" htmlFor="blf_enabled">
              <input
                id="blf_enabled"
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <div>Enabled</div>
            </label>

            <label htmlFor="blf_event_package2">Event package</label>
            <Selector
              id="blf_event_package2"
              name="blf_event_package2"
              value={eventPackage}
              options={EVENT_OPTIONS}
              onChange={(e) =>
                setEventPackage(e.target.value as BlfEventPackage)
              }
            />

            <label htmlFor="blf_subscribe_expires">
              Subscribe expires (sec)
            </label>
            <input
              id="blf_subscribe_expires"
              type="number"
              min={60}
              value={subscribeExpires}
              onChange={(e) =>
                setSubscribeExpires(parseInt(e.target.value, 10) || 3600)
              }
            />

            <label htmlFor="blf_stale_seconds">Stale after (sec)</label>
            <input
              id="blf_stale_seconds"
              type="number"
              min={30}
              value={staleSeconds}
              onChange={(e) =>
                setStaleSeconds(parseInt(e.target.value, 10) || 120)
              }
            />

            <ButtonGroup left>
              <Button
                type="button"
                small
                disabled={loading}
                onClick={handleSaveSettings}
              >
                Save BLF settings
              </Button>
              <Button
                type="button"
                small
                subStyle="grey"
                disabled={loading}
                onClick={() => loadAll()}
              >
                <Icon>
                  <Icons.RefreshCw />
                </Icon>
              </Button>
              <Button
                type="button"
                small
                subStyle="grey"
                disabled={loading}
                onClick={handleDeleteConfig}
              >
                Delete BLF
              </Button>
            </ButtonGroup>
          </fieldset>

          <fieldset>
            <div className="label">Public capability URL</div>
            <MXS>
              <em>
                Opaque Retell-friendly poll URL (no account SID). Treat as a
                secret.
              </em>
            </MXS>
            {cfg.capability_url ? (
              <ClipBoard
                id="blf_capability_url"
                name="blf_capability_url"
                text={cfg.capability_url}
              />
            ) : (
              <MS>Capability URL unavailable</MS>
            )}
            {cfg.capability_token && (
              <>
                <div className="label">New capability token</div>
                <ClipBoard
                  id="blf_capability_token"
                  name="blf_capability_token"
                  text={cfg.capability_token}
                />
              </>
            )}
            <ButtonGroup left>
              <Button
                type="button"
                small
                subStyle="grey"
                disabled={loading}
                onClick={handleRotate}
              >
                Rotate token
              </Button>
            </ButtonGroup>
          </fieldset>

          <fieldset>
            <div className="label">Live availability</div>
            {availability ? (
              <>
                <MS>
                  Observed {availability.observed_at} ·{" "}
                  {availability.counts.available}/{availability.counts.total}{" "}
                  available
                  {availability.counts.stale
                    ? ` · ${availability.counts.stale} stale`
                    : ""}
                </MS>
                <div className="i txt--teal">
                  <Icons.CheckCircle />
                  <span>
                    Idle / available:{" "}
                    {availability.available.length
                      ? availability.available.join(", ")
                      : "—"}
                  </span>
                </div>
                <div className="i txt--jam">
                  <Icons.XCircle />
                  <span>
                    Not available (busy/ringing/stale/etc):{" "}
                    {availability.unavailable.length
                      ? availability.unavailable
                          .map((ext) => {
                            const row = availability.extensions.find(
                              (e) => String(e.extension) === String(ext),
                            );
                            return row
                              ? `${ext} (${row.state}${row.stale ? ", stale" : ""})`
                              : ext;
                          })
                          .join(", ")
                      : "—"}
                  </span>
                </div>
              </>
            ) : (
              <MS>No availability snapshot yet</MS>
            )}
          </fieldset>

          <fieldset>
            <div className="label">Monitored extensions</div>
            <MXS>
              <em>
                Presentity URIs are usually{" "}
                <code>sip:&lt;ext&gt;@{defaultDomain || "domain"}</code>
              </em>
            </MXS>

            {monitors.length === 0 ? (
              <MS>No monitors configured yet.</MS>
            ) : (
              <div className="list">
                {monitors.map((m) => {
                  const live = availabilityByExt.get(String(m.extension));
                  const state = live?.state || m.state || "unknown";
                  const available = live?.available;
                  return (
                    <div className="item" key={m.blf_monitor_sid}>
                      <div className="item__info">
                        <div className="item__title">
                          <strong>{m.extension}</strong>
                          {m.display_name ? ` — ${m.display_name}` : ""}
                        </div>
                        <div className="item__meta">
                          <MS>
                            <code>{m.presentity_uri}</code>
                          </MS>
                          <div
                            className={`i txt--${stateColor(state, available)}`}
                          >
                            <span>
                              {state}
                              {live?.stale ? " (stale)" : ""}
                              {m.sub_status ? ` · sub ${m.sub_status}` : ""}
                              {!m.is_enabled ? " · disabled" : ""}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="item__actions">
                        <button
                          type="button"
                          title={m.is_enabled ? "Disable" : "Enable"}
                          onClick={() => handleToggleMonitor(m)}
                          disabled={loading}
                        >
                          <Icon>
                            {m.is_enabled ? (
                              <Icons.CheckCircle />
                            ) : (
                              <Icons.XCircle />
                            )}
                          </Icon>
                        </button>
                        <button
                          type="button"
                          title="Delete"
                          onClick={() => handleDeleteMonitor(m)}
                          disabled={loading}
                        >
                          <Icon>
                            <Icons.Trash2 />
                          </Icon>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <label htmlFor="blf_new_ext">Extension</label>
            <input
              id="blf_new_ext"
              type="text"
              value={newExt}
              placeholder="900"
              onChange={(e) => setNewExt(e.target.value)}
            />
            <label htmlFor="blf_new_label">Display name</label>
            <input
              id="blf_new_label"
              type="text"
              value={newLabel}
              placeholder="Ext 900"
              onChange={(e) => setNewLabel(e.target.value)}
            />
            <label htmlFor="blf_new_uri">
              Presentity URI <span>*</span>
            </label>
            <input
              id="blf_new_uri"
              type="text"
              value={newUri}
              placeholder={
                defaultDomain ? `sip:900@${defaultDomain}` : "sip:900@domain"
              }
              onChange={(e) => setNewUri(e.target.value)}
            />
            <ButtonGroup left>
              <Button
                type="button"
                small
                disabled={loading}
                onClick={handleAddMonitor}
              >
                <Icon>
                  <Icons.Plus />
                </Icon>
                Add monitor
              </Button>
            </ButtonGroup>
          </fieldset>
        </>
      )}
    </>
  );
};

export default CarrierBlfPanel;
