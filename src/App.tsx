import React, { useState, useRef, useCallback, useMemo } from 'react';
import Papa from 'papaparse';
import { motion, AnimatePresence } from 'motion/react';
import { 
  UploadCloud, 
  FileText, 
  FileSpreadsheet, 
  CheckCircle, 
  AlertTriangle, 
  XCircle, 
  ArrowRightLeft, 
  Trash2,
  Search,
  Info,
  ChevronRight,
  FileWarning
} from 'lucide-react';
import { cn } from './lib/utils';

// --- Types ---
interface ReconciliationResult {
  voucherNo: string;
  deliveryDate: string;
  txtAmount: number;
  csvAmount: number;
  diff: number;
  status: 'MATCH' | 'MISMATCH' | 'ONLY_TXT' | 'ONLY_CSV';
}

type FilterStatus = 'ALL' | 'MISMATCH' | 'ONLY_TXT' | 'ONLY_CSV';

// --- Parsing Logic ---
const formatDate = (dateStr: string): string => {
  if (!dateStr) return '';
  const cleaned = dateStr.replace(/[^\d]/g, '');
  if (cleaned.length === 8) {
    return `${cleaned.substring(0, 4)}/${cleaned.substring(4, 6)}/${cleaned.substring(6, 8)}`;
  }
  if (dateStr.includes('-')) {
    return dateStr.replace(/-/g, '/');
  }
  return dateStr;
};

const parseTXT = (file: File): Promise<Map<string, { amount: number, date: string }>> => {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      delimiter: '\t',
      skipEmptyLines: true,
      encoding: 'Shift_JIS',
      complete: (results) => {
        const map = new Map<string, { amount: number, date: string }>();
        results.data.forEach((row: any) => {
          const dateRaw = row[28];      // AC列 (0-indexed 28)
          const voucherNoRaw = row[38]; // AM列 (0-indexed 38)
          const qtyRaw = row[127];      // DX列 (0-indexed 127)
          const unitPriceRaw = row[135]; // EF列 (0-indexed 135)
          
          if (!voucherNoRaw) return;
          
          // ヘッダー行をスキップ
          if (String(voucherNoRaw).includes('伝票番号')) return;
          
          const voucherNo = String(voucherNoRaw).trim().replace(/^0+/, ''); // ゼロ埋め除去
          if (!voucherNo) return;

          const qty = parseFloat(qtyRaw) || 0;
          const unitPrice = parseFloat(unitPriceRaw) || 0;
          const amount = qty * unitPrice;
          const date = formatDate(String(dateRaw || '').trim());

          const existing = map.get(voucherNo);
          if (existing) {
            map.set(voucherNo, { amount: existing.amount + amount, date: existing.date || date });
          } else {
            map.set(voucherNo, { amount, date });
          }
        });
        resolve(map);
      },
      error: reject
    });
  });
};

const parseCSV = (file: File): Promise<Map<string, { amount: number, date: string }>> => {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      delimiter: ',',
      skipEmptyLines: true,
      encoding: 'Shift_JIS',
      complete: (results) => {
        const map = new Map<string, { amount: number, date: string }>();
        const data = results.data;
        
        let startIndex = 0;
        if (data.length > 0 && String(data[0][9]).includes('伝票番号')) {
          startIndex = 1; // ヘッダー行をスキップ
        }
        
        for (let i = startIndex; i < data.length; i++) {
          const row: any = data[i];
          const dateRaw = row[2];       // C列 (0-indexed 2)
          const voucherNoRaw = row[9];  // J列 (0-indexed 9)
          const amountRaw = row[15];    // P列 (0-indexed 15)
          
          if (!voucherNoRaw) continue;
          
          const voucherNo = String(voucherNoRaw).trim().replace(/^0+/, ''); // ゼロ埋め除去
          if (!voucherNo) continue;

          const amount = parseFloat(amountRaw) || 0;
          const date = formatDate(String(dateRaw || '').trim());

          const existing = map.get(voucherNo);
          if (existing) {
            map.set(voucherNo, { amount: existing.amount + amount, date: existing.date || date });
          } else {
            map.set(voucherNo, { amount, date });
          }
        }
        resolve(map);
      },
      error: reject
    });
  });
};

const reconcile = (txtMap: Map<string, { amount: number, date: string }>, csvMap: Map<string, { amount: number, date: string }>): ReconciliationResult[] => {
  const results: ReconciliationResult[] = [];
  const allKeys = new Set([...txtMap.keys(), ...csvMap.keys()]);

  allKeys.forEach(key => {
    const txtData = txtMap.get(key);
    const csvData = csvMap.get(key);

    const txtAmount = txtData?.amount;
    const csvAmount = csvData?.amount;
    
    // Date priority: CSV (②) > TXT (①)
    const deliveryDate = csvData?.date || txtData?.date || '-';

    if (txtAmount !== undefined && csvAmount !== undefined) {
      const diff = txtAmount - csvAmount;
      // 0.1%の誤差を許容 (絶対値で1未満の誤差も許容)
      const tolerance = Math.max(Math.abs(csvAmount) * 0.001, 1);
      
      if (Math.abs(diff) <= tolerance) {
        results.push({ voucherNo: key, deliveryDate, txtAmount, csvAmount, diff, status: 'MATCH' });
      } else {
        results.push({ voucherNo: key, deliveryDate, txtAmount, csvAmount, diff, status: 'MISMATCH' });
      }
    } else if (txtAmount !== undefined) {
      results.push({ voucherNo: key, deliveryDate, txtAmount, csvAmount: 0, diff: txtAmount, status: 'ONLY_TXT' });
    } else if (csvAmount !== undefined) {
      results.push({ voucherNo: key, deliveryDate, txtAmount: 0, csvAmount, diff: -csvAmount, status: 'ONLY_CSV' });
    }
  });

  return results.sort((a, b) => {
    // 日付の昇順 (日付がないものは最後に)
    if (a.deliveryDate !== b.deliveryDate) {
      if (a.deliveryDate === '-') return 1;
      if (b.deliveryDate === '-') return -1;
      return a.deliveryDate.localeCompare(b.deliveryDate);
    }
    // 日付が同じ場合はエラーを上に
    if (a.status !== 'MATCH' && b.status === 'MATCH') return -1;
    if (a.status === 'MATCH' && b.status !== 'MATCH') return 1;
    return Math.abs(b.diff) - Math.abs(a.diff);
  });
};

// --- Components ---

export default function App() {
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [txtFile, setTxtFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<ReconciliationResult[] | null>(null);
  const [filter, setFilter] = useState<FilterStatus>('ALL');

  const csvInputRef = useRef<HTMLInputElement>(null);
  const txtInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (type: 'CSV' | 'TXT', e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (type === 'CSV') setCsvFile(file);
    else setTxtFile(file);
    // Reset results when new file is uploaded
    setResults(null);
  };

  const handleDrop = (type: 'CSV' | 'TXT', e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (type === 'CSV') setCsvFile(file);
    else setTxtFile(file);
    setResults(null);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleReconcile = async () => {
    if (!csvFile || !txtFile) return;
    setIsProcessing(true);
    
    try {
      const [csvMap, txtMap] = await Promise.all([
        parseCSV(csvFile),
        parseTXT(txtFile)
      ]);
      
      const reconciliationResults = reconcile(txtMap, csvMap);
      setResults(reconciliationResults);
      setFilter('ALL');
    } catch (error) {
      console.error("Error parsing files:", error);
      alert("ファイルの解析中にエラーが発生しました。ファイル形式とエンコーディング(Shift-JIS)を確認してください。");
    } finally {
      setIsProcessing(false);
    }
  };

  const clearAll = () => {
    setCsvFile(null);
    setTxtFile(null);
    setResults(null);
    if (csvInputRef.current) csvInputRef.current.value = '';
    if (txtInputRef.current) txtInputRef.current.value = '';
  };

  const filteredResults = useMemo(() => {
    if (!results) return [];
    if (filter === 'ALL') return results;
    return results.filter(r => r.status === filter);
  }, [results, filter]);

  const summary = useMemo(() => {
    if (!results) return null;
    return {
      total: results.length,
      match: results.filter(r => r.status === 'MATCH').length,
      mismatch: results.filter(r => r.status === 'MISMATCH').length,
      onlyTxt: results.filter(r => r.status === 'ONLY_TXT').length,
      onlyCsv: results.filter(r => r.status === 'ONLY_CSV').length,
    };
  }, [results]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(amount);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans selection:bg-indigo-100 selection:text-indigo-900">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-indigo-600 p-2 rounded-lg shadow-sm shadow-indigo-200">
              <ArrowRightLeft className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 leading-tight">伝票照合ダッシュボード</h1>
              <p className="text-[10px] font-medium text-slate-500 tracking-wider uppercase">Voucher Reconciliation V1.0</p>
            </div>
          </div>
          <button 
            onClick={clearAll}
            className="flex items-center space-x-2 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            <span>クリア</span>
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        
        {/* Catchy Explanation */}
        <section className="bg-gradient-to-br from-indigo-50 to-blue-50 border border-indigo-100 rounded-2xl p-6 shadow-sm">
          <h2 className="text-xl font-bold text-indigo-900 mb-3 flex items-center">
            <span className="text-2xl mr-2">✨</span> ジョイフル本田 納品データ照合アプリ
          </h2>
          <p className="text-indigo-800 leading-relaxed">
            オラクルクラウドの「<strong className="font-semibold">納品確定データ(.txt)</strong>」と、新見れるクンの「<strong className="font-semibold">ジョイフル納品確定チェック(.csv)</strong>」をアップロードするだけで、伝票ごとの金額差異を瞬時に自動チェックします！🔍<br/>
            計算時の小数点の切り上げ・切り捨てによる<strong className="font-semibold">0.1%の端数誤差は自動で許容</strong>されるので、本当に確認が必要なズレだけを一目で発見できます💡
          </p>
        </section>

        {/* Upload Section */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* CSV Upload */}
          <div 
            onDrop={(e) => handleDrop('CSV', e)}
            onDragOver={handleDragOver}
            className={cn(
              "relative group flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-2xl transition-all duration-200 bg-white",
              csvFile ? "border-indigo-400 bg-indigo-50/30" : "border-slate-300 hover:border-indigo-400 hover:bg-slate-50"
            )}
          >
            <input 
              type="file" 
              accept=".csv" 
              className="hidden" 
              ref={csvInputRef} 
              onChange={(e) => handleFileChange('CSV', e)} 
            />
            <div className="w-12 h-12 mb-4 rounded-full bg-slate-100 flex items-center justify-center group-hover:bg-indigo-100 transition-colors">
              <FileSpreadsheet className={cn("w-6 h-6", csvFile ? "text-indigo-600" : "text-slate-400 group-hover:text-indigo-600")} />
            </div>
            <h3 className="text-base font-semibold text-slate-900 mb-1">計上データ (CSV)</h3>
            <p className="text-sm text-slate-500 mb-4 text-center">
              J列: 納品伝票番号 / P列: 売上金額<br/>
              <span className="text-xs opacity-75">※新見れるクン「ジョイフル納品確定チェック」</span>
            </p>
            
            {csvFile ? (
              <div className="flex items-center space-x-2 text-sm font-medium text-indigo-700 bg-indigo-100/50 px-4 py-2 rounded-full">
                <CheckCircle className="w-4 h-4" />
                <span className="truncate max-w-[200px]">{csvFile.name}</span>
              </div>
            ) : (
              <button 
                onClick={() => csvInputRef.current?.click()}
                className="flex items-center space-x-2 px-5 py-2.5 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium rounded-full transition-colors text-sm"
              >
                <span>ファイルを選択</span>
                <UploadCloud className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* TXT Upload */}
          <div 
            onDrop={(e) => handleDrop('TXT', e)}
            onDragOver={handleDragOver}
            className={cn(
              "relative group flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-2xl transition-all duration-200 bg-white",
              txtFile ? "border-indigo-400 bg-indigo-50/30" : "border-slate-300 hover:border-indigo-400 hover:bg-slate-50"
            )}
          >
            <input 
              type="file" 
              accept=".txt,.csv" 
              className="hidden" 
              ref={txtInputRef} 
              onChange={(e) => handleFileChange('TXT', e)} 
            />
            <div className="w-12 h-12 mb-4 rounded-full bg-slate-100 flex items-center justify-center group-hover:bg-indigo-100 transition-colors">
              <FileText className={cn("w-6 h-6", txtFile ? "text-indigo-600" : "text-slate-400 group-hover:text-indigo-600")} />
            </div>
            <h3 className="text-base font-semibold text-slate-900 mb-1">伝送データ (TXT)</h3>
            <p className="text-sm text-slate-500 mb-4 text-center">
              AM列: 伝票番号 / DX列×EF列: 原価金額<br/>
              <span className="text-xs opacity-75">※オラクルクラウド「納品確定ダウンロード」</span>
            </p>
            
            {txtFile ? (
              <div className="flex items-center space-x-2 text-sm font-medium text-indigo-700 bg-indigo-100/50 px-4 py-2 rounded-full">
                <CheckCircle className="w-4 h-4" />
                <span className="truncate max-w-[200px]">{txtFile.name}</span>
              </div>
            ) : (
              <button 
                onClick={() => txtInputRef.current?.click()}
                className="flex items-center space-x-2 px-5 py-2.5 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium rounded-full transition-colors text-sm"
              >
                <span>ファイルを選択</span>
                <UploadCloud className="w-4 h-4" />
              </button>
            )}
          </div>
        </section>

        {/* Action Button */}
        <div className="flex justify-center">
          <button
            onClick={handleReconcile}
            disabled={!csvFile || !txtFile || isProcessing}
            className={cn(
              "group relative flex items-center space-x-2 px-8 py-3.5 rounded-full font-bold text-lg transition-all duration-300 shadow-sm",
              (!csvFile || !txtFile) 
                ? "bg-slate-100 text-slate-400 cursor-not-allowed" 
                : "bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"
            )}
          >
            {isProcessing ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
            ) : (
              <Search className="w-5 h-5" />
            )}
            <span>照合を実行する</span>
            {csvFile && txtFile && !isProcessing && (
              <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            )}
          </button>
        </div>

        {/* Empty State / Results */}
        <AnimatePresence mode="wait">
          {!results ? (
            <motion.div 
              key="empty"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex flex-col items-center justify-center py-16 text-center"
            >
              <div className="w-20 h-20 bg-white rounded-2xl shadow-sm border border-slate-100 flex items-center justify-center mb-6">
                <Search className="w-8 h-8 text-slate-300" />
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-2">データが未読込です</h3>
              <p className="text-slate-500 max-w-md">
                上部のパネルからファイルを2つ選択し、<br/>
                照合ボタンをクリックして業務を開始してください。
              </p>
            </motion.div>
          ) : (
            <motion.div 
              key="results"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              {/* Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
                  <div className="text-sm font-medium text-slate-500 mb-1">総伝票数</div>
                  <div className="text-3xl font-bold text-slate-900">{summary?.total}</div>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-emerald-100 shadow-sm relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-4 opacity-10"><CheckCircle className="w-12 h-12 text-emerald-600" /></div>
                  <div className="text-sm font-medium text-emerald-600 mb-1">一致</div>
                  <div className="text-3xl font-bold text-emerald-700">{summary?.match}</div>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-rose-100 shadow-sm relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-4 opacity-10"><AlertTriangle className="w-12 h-12 text-rose-600" /></div>
                  <div className="text-sm font-medium text-rose-600 mb-1">金額不一致</div>
                  <div className="text-3xl font-bold text-rose-700">{summary?.mismatch}</div>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-amber-100 shadow-sm relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-4 opacity-10"><FileWarning className="w-12 h-12 text-amber-600" /></div>
                  <div className="text-sm font-medium text-amber-600 mb-1">片方のみ存在</div>
                  <div className="text-3xl font-bold text-amber-700">{(summary?.onlyTxt || 0) + (summary?.onlyCsv || 0)}</div>
                </div>
              </div>

              {/* Data Table */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                {/* Filters */}
                <div className="p-4 border-b border-slate-100 flex flex-wrap gap-2 bg-slate-50/50">
                  <FilterButton active={filter === 'ALL'} onClick={() => setFilter('ALL')} label={`すべて (${summary?.total})`} />
                  <FilterButton active={filter === 'MISMATCH'} onClick={() => setFilter('MISMATCH')} label={`金額不一致 (${summary?.mismatch})`} color="rose" />
                  <FilterButton active={filter === 'ONLY_TXT'} onClick={() => setFilter('ONLY_TXT')} label={`伝送(TXT)のみ (${summary?.onlyTxt})`} color="amber" />
                  <FilterButton active={filter === 'ONLY_CSV'} onClick={() => setFilter('ONLY_CSV')} label={`計上(CSV)のみ (${summary?.onlyCsv})`} color="amber" />
                </div>

                {/* Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm whitespace-nowrap">
                    <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-4">ステータス</th>
                        <th className="px-6 py-4">納品年月日</th>
                        <th className="px-6 py-4">伝票番号</th>
                        <th className="px-6 py-4 text-right">伝送データ (TXT) 金額</th>
                        <th className="px-6 py-4 text-right">計上データ (CSV) 金額</th>
                        <th className="px-6 py-4 text-right">差額 (TXT - CSV)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredResults.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                            該当するデータがありません
                          </td>
                        </tr>
                      ) : (
                        filteredResults.map((row) => (
                          <tr key={row.voucherNo} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-6 py-3">
                              <StatusBadge status={row.status} />
                            </td>
                            <td className="px-6 py-3 font-mono text-slate-600">{row.deliveryDate}</td>
                            <td className="px-6 py-3 font-mono text-slate-700">{row.voucherNo}</td>
                            <td className="px-6 py-3 text-right font-mono text-slate-600">
                              {row.status !== 'ONLY_CSV' ? formatCurrency(row.txtAmount) : '-'}
                            </td>
                            <td className="px-6 py-3 text-right font-mono text-slate-600">
                              {row.status !== 'ONLY_TXT' ? formatCurrency(row.csvAmount) : '-'}
                            </td>
                            <td className={cn(
                              "px-6 py-3 text-right font-mono font-medium",
                              row.diff === 0 ? "text-slate-400" : 
                              row.status === 'MATCH' ? "text-emerald-600" : "text-rose-600"
                            )}>
                              {row.diff > 0 ? '+' : ''}{formatCurrency(row.diff)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

// --- Sub Components ---

function FilterButton({ active, onClick, label, color = 'indigo' }: { active: boolean, onClick: () => void, label: string, color?: 'indigo' | 'rose' | 'amber' }) {
  const colorStyles = {
    indigo: active ? "bg-indigo-100 text-indigo-700 border-indigo-200" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50",
    rose: active ? "bg-rose-100 text-rose-700 border-rose-200" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50",
    amber: active ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50",
  };

  return (
    <button
      onClick={onClick}
      className={cn(
        "px-4 py-2 rounded-full text-sm font-medium border transition-colors",
        colorStyles[color]
      )}
    >
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: ReconciliationResult['status'] }) {
  switch (status) {
    case 'MATCH':
      return (
        <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-700 text-xs font-medium border border-emerald-100">
          <CheckCircle className="w-3.5 h-3.5" />
          <span>一致</span>
        </span>
      );
    case 'MISMATCH':
      return (
        <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-rose-50 text-rose-700 text-xs font-medium border border-rose-100">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>不一致</span>
        </span>
      );
    case 'ONLY_TXT':
      return (
        <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-amber-50 text-amber-700 text-xs font-medium border border-amber-100">
          <FileText className="w-3.5 h-3.5" />
          <span>伝送(TXT)のみ</span>
        </span>
      );
    case 'ONLY_CSV':
      return (
        <span className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-amber-50 text-amber-700 text-xs font-medium border border-amber-100">
          <FileSpreadsheet className="w-3.5 h-3.5" />
          <span>計上(CSV)のみ</span>
        </span>
      );
  }
}
