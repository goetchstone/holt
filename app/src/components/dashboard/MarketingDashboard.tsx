// /app/src/components/dashboard/MarketingDashboard.tsx

import { useEffect, useState } from "react";
import axios from "axios";
import { format } from "date-fns";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";

type Campaign = {
  id: string;
  title: string;
  subject_line: string;
  send_time: string;
  emails_sent: number;
  status: string;
};

type CampaignReport = {
  id: string;
  subject_line: string;
  emails_sent: number;
  opens: number;
  unique_opens: number;
  open_rate: number;
  clicks: number;
  unique_clicks: number;
  click_rate: number;
  bounces: number;
  unsubscribes: number;
};

export default function MarketingDashboard() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [campaignReport, setCampaignReport] = useState<CampaignReport | null>(null);

  useEffect(() => {
    fetchCampaigns();
  }, []);

  const fetchCampaigns = async () => {
    try {
      const res = await axios.get("/api/mailchimp/campaigns");
      setCampaigns(res.data.campaigns);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load campaigns."));
    }
  };

  const fetchCampaignReport = async (id: string) => {
    try {
      const res = await axios.get(`/api/mailchimp/campaigns/${id}`);
      setCampaignReport(res.data);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load campaign report."));
    }
  };

  const handleCampaignClick = (campaign: Campaign) => {
    setSelectedCampaign(campaign);
    fetchCampaignReport(campaign.id);
  };

  return (
    <div className="flex flex-col md:flex-row gap-6">
      {/* Campaign List */}
      <div className="md:w-1/2 border rounded p-4 bg-white shadow">
        <h2 className="text-xl font-serif text-sh-blue mb-2">Campaigns</h2>
        <ul className="space-y-2">
          {campaigns.map((campaign) => (
            <li
              key={campaign.id}
              className="cursor-pointer hover:bg-sh-gray p-2 rounded transition"
              role="button"
              tabIndex={0}
              onClick={() => handleCampaignClick(campaign)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleCampaignClick(campaign);
                }
              }}
            >
              <div className="font-semibold">{campaign.title}</div>
              <div className="text-sm text-sh-black">
                {campaign.status} • {campaign.emails_sent} sent •{" "}
                {campaign.send_time ? format(new Date(campaign.send_time), "PPpp") : "Not sent"}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Campaign Report */}
      <div className="md:w-1/2 border rounded p-4 bg-white shadow">
        <h2 className="text-xl font-serif text-sh-blue mb-2">Campaign Report</h2>
        {selectedCampaign && campaignReport ? (
          <div className="space-y-2">
            <div className="font-serif text-lg">{campaignReport.subject_line}</div>
            <div>Emails Sent: {campaignReport.emails_sent}</div>
            <div>
              Opens: {campaignReport.opens} (Unique: {campaignReport.unique_opens})
            </div>
            <div>Open Rate: {(campaignReport.open_rate * 100).toFixed(1)}%</div>
            <div>
              Clicks: {campaignReport.clicks} (Unique: {campaignReport.unique_clicks})
            </div>
            <div>Click Rate: {(campaignReport.click_rate * 100).toFixed(1)}%</div>
            <div>Bounces: {campaignReport.bounces}</div>
            <div>Unsubscribes: {campaignReport.unsubscribes}</div>
          </div>
        ) : (
          <div className="text-sh-black">Select a campaign to view details.</div>
        )}
      </div>
    </div>
  );
}
